// 本机设备身份：和墨宝桌面端同一套算法（hardware-v1），只在本机记录，不上传。
//
// 桌面端（app.asar 里 dist/electron/main/index.js）的算法：
//   uuid = Win32_ComputerSystemProduct.UUID（mac 用 IOPlatformUUID，linux 用 dmi product_uuid）
//   sn   = BIOS 序列号，被占位符黑名单过滤掉时改用主板序列号
//   fingerprint = sha256(['hardware-v1', platform, normalize(uuid), normalize(sn)].join('|'))
// 本模块复刻了它（实测算出的指纹与 mobook.json 的 hardware.fingerprint 逐字节相等），并提供账号派生：
//   - 复用态（导入本机客户端）：直接用客户端已有的 fingerprint + 本机 hostname；
//   - 新建态（手机号 / 粘贴 _tk）：fingerprint = sha256(基础指纹 + '|uid:' + uid)，
//     客户端名由 windowsClientName(uid) 在本地稳定生成。
// 所以：同一机器 + 同一账号永远同一个设备码；同一机器不同账号不同设备码；换机器自然变。
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { hostname } from 'node:os'

export const FINGERPRINT_VERSION = 'hardware-v1'

// 桌面端的占位符黑名单：这些“序列号”是 OEM 默认串，不能当设备标识。
const PLACEHOLDER_EXACT = new Set([
  '', '0', '00', '000', '0000', 'none', 'null', 'undefined', 'unknown', 'default', 'default string',
  'system serial number', 'serial number', 'base board serial number', 'motherboard serial number',
  'chassis serial number', 'to be filled by o.e.m.', 'to be filled by oem', 'not specified',
  'not available', 'not applicable', 'no asset information', 'no serial number', 'no serial',
  'empty', 'blank', 'o.e.m.', 'oem', 'reserved', 'invalid', 'n/a', 'na',
  '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
])

const PLACEHOLDER_PATTERNS = [
  /^0+$/, /^f+$/i, /^x+$/i, /^-+$/, /^\.+$/, /^\s*$/, /^\?+$/, /^#+$/, /^\*+$/,
  /^null\s*$/i, /^none\s*$/i, /^unknown\s*$/i, /^default(?:\s+string)?\s*$/i,
  /^not\s+(?:specified|available|applicable|present|provided|set)\s*$/i,
  /^no\s+(?:asset\s+information|serial(?:\s+number)?|information)\s*$/i,
  /^to\s+be\s+filled\s+by\s+(?:o\.?e\.?m\.?|oem)\.?$/i,
  /^(?:system|base\s*board|motherboard|chassis)?\s*serial\s*number\s*$/i,
  /^(?:o\.?e\.?m\.?|oem)\s*(?:string|serial|serial\s*number)?\s*$/i,
]

// normalizeSignal 与桌面端一致：去 NUL、压空白、trim、小写。
export function normalizeSignal(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\s+/g, ' ').trim().toLowerCase()
}

// usableSignal 复刻桌面端 yf()：过滤占位符、重复字符、全 0 / 全 f 之类的假序列号。
export function usableSignal(value) {
  const text = String(value ?? '').replaceAll('\0', '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (PLACEHOLDER_EXACT.has(text.toLowerCase())) return ''
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text))) return ''
  const compact = text.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!compact || compact.length < 5 || new Set(compact).size <= 1) return ''
  const distinct = Array.from(new Set(compact))
  const most = Math.max(...distinct.map((ch) => compact.split(ch).length - 1))
  if (compact.length >= 8 && most / compact.length >= 0.85) return ''
  if (/^(?:0123456789|1234567890|123456789|abcdef|abcdefg|abcdefgh)$/i.test(compact)) return ''
  return text
}

// fingerprintOf 是桌面端的 zH()：sha256('hardware-v1|平台|uuid|sn')，没有信号时退化成只有平台。
export function fingerprintOf({ uuid = '', sn = '' } = {}, platformName = process.platform) {
  const signals = [uuid, sn].filter((value) => !!value).map(normalizeSignal)
  return createHash('sha256').update([FINGERPRINT_VERSION, platformName, ...signals].join('|'), 'utf8').digest('hex')
}

// accountFingerprint 把账号拼进指纹：同机同号恒定，同机不同号不同。
export function accountFingerprint(baseFingerprint, uid) {
  const id = String(uid ?? '').trim()
  const base = String(baseFingerprint ?? '').trim()
  if (!id || !base) return base
  return createHash('sha256').update(base + '|uid:' + id, 'utf8').digest('hex')
}

// deviceIdFrom 生成客户端的 deviceToken（43 字符 base64url，和客户端 gateway:getDeviceId 同格式）。
// 只写进本地 metadata，登录取 token 时作为 deviceToken 提交，用来登记一台独立客户端。
export function deviceIdFrom(seed) {
  const digest = createHash('sha256').update('device-token|' + String(seed ?? '').trim(), 'utf8').digest()
  return digest.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '').slice(0, 43)
}

// windowsClientName 生成“本地客户端名称”，采用 Windows 自动命名格式（DESKTOP-XXXXXXX）。
// 中间 7 位是用户名（账号 uid / 手机号）做一次 MD5 后的前 7 位（大写十六进制），因此：
//   - 同一个用户永远是同一个名称（换机器也不变），插件每次登录都能复用这台客户端；
//   - 不同用户名称不同，不会互相顶掉对方的客户端。
// 只写进本地 metadata，绝不发给墨宝；登录后登记客户端时作为 botName 提交。
export function windowsClientName(seed) {
  const text = String(seed ?? '').trim() || 'magpie'
  const digest = createHash('md5').update(text, 'utf8').digest('hex').toUpperCase()
  return 'DESKTOP-' + digest.slice(0, 7)
}


export function localHostName() {
  try {
    const name = hostname().replace(/\.$/u, '').trim()
    return name || 'DESKTOP-MAGPIE'
  } catch {
    return 'DESKTOP-MAGPIE'
  }
}

// run 执行一条命令，失败返回空串（桌面端 t1() 的做法）。
// 6 秒足够 PowerShell 启动并读一次 CIM；原来 15 秒，慢机器上会把「登录中」拖到十几秒。
function run(file, args, exec) {
  return new Promise((resolve) => {
    exec(file, args, { timeout: 6000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout ?? '').trim())
    })
  })
}

function powerShellValue(className, property, exec) {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$value = (Get-CimInstance -ClassName ${className}).${property}`,
    'if ($value -is [array]) { $value = $value | Select-Object -First 1 }',
    'Write-Output $value',
  ].join('; ')
  return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], exec)
}

// 硬件探测结果在进程内缓存：登录流程会调它，而三个 PowerShell 各要几百毫秒到几秒。
// 同一台机器的指纹本来就不变，没必要每次登录都重新探测（慢机器上「登录中」会明显卡住）。
let hardwareCache = null

// detectHardware 取本机 uuid / sn，顺序与桌面端 LH() 一致。
export async function detectHardware({ platform = process.platform, exec = execFile, readDmi = null } = {}) {
  if (hardwareCache && hardwareCache.platform === platform) return hardwareCache.value
  const value = await detectHardwareUncached({ platform, exec, readDmi })
  hardwareCache = { platform, value }
  return value
}

async function detectHardwareUncached({ platform, exec, readDmi }) {
  if (platform === 'win32') {
    const [uuid, bios, board] = await Promise.all([
      powerShellValue('Win32_ComputerSystemProduct', 'UUID', exec),
      powerShellValue('Win32_BIOS', 'SerialNumber', exec),
      powerShellValue('Win32_BaseBoard', 'SerialNumber', exec),
    ])
    return { uuid: usableSignal(uuid), sn: usableSignal(bios) || usableSignal(board) }
  }
  if (platform === 'darwin') {
    const ioreg = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], exec)
    const profiler = await run('system_profiler', ['SPHardwareDataType'], exec)
    const uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/i.exec(ioreg)?.[1]
    const sn = /(?:Serial Number \(system\)|Serial Number):\s*(.+)/i.exec(profiler)?.[1]
    return { uuid: usableSignal(uuid), sn: usableSignal(sn) }
  }
  const reader = readDmi ?? (async (name) => {
    try {
      const { readFile } = await import('node:fs/promises')
      return await readFile('/sys/class/dmi/id/' + name, 'utf8')
    } catch {
      return ''
    }
  })
  const [uuid, product, board] = await Promise.all([reader('product_uuid'), reader('product_serial'), reader('board_serial')])
  return { uuid: usableSignal(uuid), sn: usableSignal(product) || usableSignal(board) }
}

// fallbackSignals 对应桌面端 FH()：拿不到硬件时给一个确定的替代（主机名 + 平台），避免每次变。
export function fallbackSignals(platform = process.platform) {
  return { uuid: createHash('sha256').update('host:' + localHostName() + '|' + platform, 'utf8').digest('hex'), sn: 'unknown' }
}

// resolveDevice 决定这次登录用哪套设备信息；返回的字段写进凭据 metadata.device，只本地记录。
//   mode='reuse'  复用本机客户端（mobook.json 的硬件指纹 + 本机 hostname）
//   mode='web'    默认：按 (本机硬件, 账号) 派生，代表“网页版”这个接入端（兼容旧值 'cloud' / 'generated'）
export async function resolveDevice({ uid, mode = 'web', clientState = null, platform = process.platform, exec = execFile, detect = detectHardware } = {}) {
  const id = String(uid ?? '').trim()
  if (mode === 'reuse') {
    const stored = clientState?.hardware
    if (stored?.fingerprint) {
      return {
        mode: 'reuse',
        fingerprint: String(stored.fingerprint),
        fingerprintVersion: String(stored.fingerprintVersion || FINGERPRINT_VERSION),
        botName: localHostName(),
      }
    }
  }
  let signals = null
  try {
    signals = await detect({ platform, exec })
  } catch {
    signals = null
  }
  const usable = signals && (signals.uuid || signals.sn) ? signals : fallbackSignals(platform)
  const base = fingerprintOf(usable, platform)
  const fingerprint = accountFingerprint(base, id)
  return {
    mode: 'web',
    fingerprint,
    fingerprintVersion: FINGERPRINT_VERSION,
    // 本地生成的客户端信息：账号唯一指纹 + 按用户（uid）算出的 Windows 名称；
    // 只记本地，登录登记客户端时作为 botName 提交。
    botName: windowsClientName(id),
  }
}