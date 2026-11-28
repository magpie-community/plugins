// 本地假上游：模拟 Gemini Decisions API 的最小行为。
// POST /v1beta/decisions  → 校验 x-goog-api-key / input / model，返回与 questions 对应的 answers
// GET  /v1beta/models     → 返回固定模型清单

import http from 'node:http'

export function startMockUpstream({ port = 0, validKey = 'test-key' } = {}) {
  const requests = []

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body }
      requests.push(record)

      const key = req.headers['x-goog-api-key']
      if (!key || key !== validKey) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 401, message: 'API key not valid' } }))
        return
      }

      if (req.method === 'POST' && req.url.endsWith('/decisions')) {
        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 400, message: 'invalid json' } }))
          return
        }
        if (!('input' in parsed)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 400, message: 'input is required' } }))
          return
        }
        const answers = {}
        for (const [qid, q] of Object.entries(parsed.questions || {})) {
          if (q.type === 'noul') {
            answers[qid] = { type: 'noul', noul: 0.87, confidence: 0.87 }
          } else if (q.type === 'choice') {
            const first = Object.keys(q.criteria || {})[0] || 'unknown'
            answers[qid] = {
              type: 'choice',
              choice: first,
              probabilities: Object.fromEntries(Object.keys(q.criteria || {}).map((k, i) => [k, i === 0 ? 0.9 : 0.1])),
              confidence: 0.9,
            }
          } else if (q.type === 'score') {
            answers[qid] = {
              type: 'score',
              score: 1.5,
              legend: { 0: 'low', 1: 'mid', 2: 'high' },
              probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 },
              confidence: 0.6,
            }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            answers,
            usage: { total_input_tokens: 120, total_output_tokens: 0, total_tokens: 120 },
          }),
        )
        return
      }

      if (req.method === 'GET' && req.url.includes('/models')) {
        // 谷歌的真实形状：name 带 "models/" 前缀，列表里混着普通聊天/embedding 模型。
        // 第一页给 nextPageToken，第二页收尾，供分页逻辑测试。
        const isPage2 = req.url.includes('pageToken=page2')
        const page1 = {
          models: [
            { name: 'models/gemini-2.5-flash', description: 'chat model' },
            { name: 'models/text-embedding-004', description: 'embedding model' },
          ],
          nextPageToken: 'page2',
        }
        const page2 = {
          models: [
            { name: 'models/gemini-decision-1', description: 'The decision model' },
            { name: 'models/gemini-2.5-flash-lite', description: 'another chat model' },
          ],
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(isPage2 ? page2 : page1))
        return
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 404, message: 'not found' } }))
    })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        requests,
        url: `http://127.0.0.1:${server.address().port}/v1beta`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}
