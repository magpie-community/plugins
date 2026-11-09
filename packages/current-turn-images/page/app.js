(() => {
  const byId = id => document.getElementById(id);
  let snapshot = {records: [], totalRecorded: 0};
  let page = 0;
  let pending;
  const expanded = new Set();
  const bytes = value => {
    if (value === null || value === undefined) return '未知';
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB';
    return (value / (1024 * 1024)).toFixed(2) + ' MiB';
  };
  const cell = (row, text, className) => {
    const element = document.createElement('td');
    element.textContent = text;
    if (className) element.className = className;
    row.append(element);
    return element;
  };
  const detailedBytes = value => bytes(value) + '（' + value.toLocaleString() + ' 字节）';
  function render() {
    const records = snapshot.records.filter(record => !byId('only-removed').checked || record.removedImages > 0 || record.compressedImages > 0);
    const pages = Math.max(1, Math.ceil(records.length / 25));
    page = Math.min(page, pages - 1);
    const sum = key => records.reduce((total, record) => total + (record[key] || 0), 0);
    byId('count').textContent = records.length.toLocaleString();
    byId('before').textContent = bytes(sum('requestBytesBefore'));
    byId('after').textContent = bytes(sum('requestBytesAfter'));
    byId('saved').textContent = bytes(sum('savedBytes'));
    byId('status').textContent = (snapshot.day || '今天') + ' · ' + snapshot.totalRecorded + ' 次请求';
    byId('empty').hidden = records.length !== 0;
    byId('page-number').textContent = (page + 1) + ' / ' + pages;
    byId('previous').disabled = page === 0;
    byId('next').disabled = page === pages - 1;
    const fragment = document.createDocumentFragment();
    for (const record of records.slice(page * 25, (page + 1) * 25)) {
      const row = document.createElement('tr');
      const time = cell(row, new Date(record.time).toLocaleTimeString('zh-CN', {hour12: false}));
      const model = document.createElement('span');
      model.className = 'model';
      model.textContent = [record.agent, record.model || record.protocol].filter(Boolean).join(' · ');
      time.append(model);
      cell(row, bytes(record.requestBytesBefore)).title = detailedBytes(record.requestBytesBefore);
      const after = cell(row, bytes(record.requestBytesAfter));
      after.title = detailedBytes(record.requestBytesAfter);
      const percent = record.savedBytes / Math.max(1, record.requestBytesBefore) * 100;
      cell(row, bytes(record.savedBytes) + ' · ' + percent.toFixed(1) + '%', 'delta');
      cell(row, bytes(record.removedImageJsonBytes));
      cell(row, record.removedImages + ' / ' + record.keptCurrentImages);
      const action = cell(row, '');
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = expanded.has(record.id) ? '收起' : '展开';
      button.setAttribute('aria-expanded', String(expanded.has(record.id)));
      button.addEventListener('click', () => { if (expanded.has(record.id)) expanded.delete(record.id); else expanded.add(record.id); render(); });
      action.append(button); fragment.append(row);
      if (expanded.has(record.id)) {
        const details = document.createElement('tr'); details.className = 'details';
        const policy = record.imagePolicy === 'latest-request-input' ? '最新请求输入' : record.imagePolicy === 'unrecognized' ? '未识别' : '旧版用户轮次';
        const description = cell(details, '范围：' + policy + ' · 图片字段 ' + detailedBytes(record.imageJsonBytesBefore) + ' → ' + detailedBytes(record.imageJsonBytesAfter) + ' · 占位 ' + record.placeholderMessages + ' 条。');
        if (record.compressedImages !== undefined) description.append(document.createTextNode(' 无损优化 ' + record.compressedImages + ' 张，减少请求 ' + bytes(record.compressionSavedRequestBytes || 0) + '。'));
        description.colSpan = 7;
        const list = document.createElement('ul');
        for (const image of record.removedDetails) {
          const item = document.createElement('li');
          const location = image.path ? ' · ' + (image.role || '') + ' · ' + image.path.join('.') : '';
          item.textContent = '消息 ' + (image.messageIndex + 1) + '，内容块 ' + (image.partIndex + 1) + location + ' · 字段 ' + detailedBytes(image.jsonBytes) + ' · 图片文件 ' + (image.embeddedBytes === null ? '未知' : detailedBytes(image.embeddedBytes));
          list.append(item);
        }
        if (!record.removedDetails.length) description.append(document.createTextNode('移除 0 张'));
        const reasons = {not_smaller: '优化后不更小', external_reference: '未内嵌图片字节', unsupported_format: '暂无安全无损编码器', invalid_base64: '无效 Base64', invalid_image: '无效图片结构',
          raw_limit: '超过像素／帧内存限制', input_limit: '超过输入大小限制', metadata_limit: '压缩元数据超过安全大小限制', protected_metadata: '保护签名／偏移元数据',
          validation_failed: '无损／元数据校验未通过', timeout: '优化超时', aborted: '请求已取消', budget_exhausted: '达到请求时间预算', busy: '优化器忙', disabled: '压缩已关闭',
          codec_failed: '编码器未成功处理', tool_unavailable: '优化工具不可用', tool_integrity: '工具完整性校验失败', output_limit: '超过输出限制'};
        for (const image of record.compressionDetails || []) {
          const item = document.createElement('li');
          item.textContent = '无损优化 · ' + (image.format || '引用').toUpperCase() + ' · 消息 ' + (image.messageIndex + 1) + ' · ' + image.path.join('.') + ' · '
            + (image.status === 'compressed' ? bytes(image.bytesBefore) + ' → ' + bytes(image.bytesAfter) : '保留原图：' + (reasons[image.reason] || image.reason));
          list.append(item);
        }
        description.append(list); fragment.append(details);
      }
    }
    byId('rows').replaceChildren(fragment);
  }
  window.receiveImageMetrics = data => {
    clearTimeout(pending);
    if (snapshot.day === data.day && snapshot.totalRecorded === data.totalRecorded
      && snapshot.records[0]?.id === data.records[0]?.id) return;
    snapshot = data;
    render();
  };
  function refresh() {
    document.getElementById('metrics-snapshot')?.remove();
    const script = document.createElement('script');
    script.id = 'metrics-snapshot';
    script.src = 'snapshot.js?revision=' + Date.now();
    script.onerror = () => { byId('status').textContent = '记录暂时无法读取，请点击刷新记录。'; };
    document.head.append(script);
    clearTimeout(pending);
    pending = setTimeout(() => { byId('status').textContent = '读取记录超时，请重新打开插件页。'; }, 6000);
  }
  byId('refresh').addEventListener('click', refresh);
  byId('only-removed').addEventListener('change', () => { page = 0; render(); });
  byId('previous').addEventListener('click', () => { page--; render(); });
  byId('next').addEventListener('click', () => { page++; render(); });
  refresh();
  setInterval(refresh, 2000);
})();
