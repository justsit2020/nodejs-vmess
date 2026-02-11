'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PANEL_PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || '7682', 10);

// 你说环境变量不能填：把这里写死即可（必须改 UUID）
const HARD_UUID = 'e0d103e8-a108-407f-9ec9-1c5368128833';
const HARD_NAME = 'ARGO';
const HARD_WS_PATH = '/vmess-argo';

// 可选：如果你想换下载源，也可以写死在这里（留空就用默认）
const HARD_SB_URL_AMD64 = ''; // 例如 'https://amd64.ssss.nyc.mn/sb'
const HARD_CF_URL_AMD64 = ''; // 例如 'https://amd64.ssss.nyc.mn/2go'
const HARD_SB_URL_ARM64 = ''; // 例如 'https://arm64.ssss.nyc.mn/sb'
const HARD_CF_URL_ARM64 = ''; // 例如 'https://arm64.ssss.nyc.mn/2go'

// 实际使用：优先读环境变量，否则用写死值
const UUID = (process.env.UUID || HARD_UUID).trim();
const NAME = (process.env.NAME || HARD_NAME).trim();
const WS_PATH_RAW = (process.env.WS_PATH || HARD_WS_PATH).trim() || '/vmess-argo';
const WS_PATH = WS_PATH_RAW.startsWith('/') ? WS_PATH_RAW : `/${WS_PATH_RAW}`;

const BASE_DIR = '/root';
const BIN_DIR = path.join(BASE_DIR, 'bin');
const SB_PATH = path.join(BIN_DIR, 'web');
const CF_PATH = path.join(BIN_DIR, 'bot');
const CFG_PATH = path.join(BIN_DIR, 'config.json');

let printed = false;

function log(s) {
  const line = String(s || '').trimEnd();
  if (line) console.log(line);
}
function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}
async function exists(p) {
  try { await fs.promises.access(p, fs.constants.F_OK); return true; } catch { return false; }
}

function archTag() {
  const a = os.arch();
  if (a === 'arm64' || a === 'aarch64' || a.startsWith('arm')) return 'arm64';
  return 'amd64';
}

function getUrls() {
  const arch = archTag();
  if (arch === 'arm64') {
    return {
      sb: (process.env.SB_URL_ARM64 || HARD_SB_URL_ARM64 || 'https://arm64.ssss.nyc.mn/sb'),
      cf: (process.env.CF_URL_ARM64 || HARD_CF_URL_ARM64 || 'https://arm64.ssss.nyc.mn/2go')
    };
  }
  return {
    sb: (process.env.SB_URL_AMD64 || HARD_SB_URL_AMD64 || 'https://amd64.ssss.nyc.mn/sb'),
    cf: (process.env.CF_URL_AMD64 || HARD_CF_URL_AMD64 || 'https://amd64.ssss.nyc.mn/2go')
  };
}

// 关键：启动前清理历史垃圾，给磁盘腾空间（你不能敲命令，就让脚本做）
async function cleanupHeavyFiles() {
  const targets = [
    path.join(BASE_DIR, 'node_modules'),
    path.join(BASE_DIR, '.npm'),
    path.join(BASE_DIR, '.runtime'),
    path.join(BASE_DIR, 'package-lock.json'),
    path.join(BASE_DIR, 'boot.log'),
    path.join(BASE_DIR, 'list.txt'),
    path.join(BASE_DIR, 'web'),
    path.join(BASE_DIR, 'bot'),
    path.join(BASE_DIR, 'frpc'),
  ];

  for (const t of targets) {
    try {
      await fs.promises.rm(t, { recursive: true, force: true });
    } catch {}
  }
}

// 用 curl 下载到磁盘文件，避免 Node fetch 造成额外内存压力
function downloadWithCurl(url, outPath) {
  return new Promise((resolve, reject) => {
    const tmp = `${outPath}.tmp`;
    const args = [
      '-L', '--fail', '--retry', '2',
      '--connect-timeout', '10', '--max-time', '300',
      '--silent', '--show-error',
      '-o', tmp,
      url
    ];

    const p = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let err = '';
    p.stderr.on('data', d => err += d.toString('utf8'));

    p.on('exit', async (code) => {
      if (code !== 0) {
        return reject(new Error(`curl failed code=${code}: ${err.trim()}`));
      }
      try {
        await fs.promises.rename(tmp, outPath);
        await fs.promises.chmod(outPath, 0o755);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function ensureBinaries() {
  await ensureDir(BIN_DIR);
  const { sb, cf } = getUrls();

  if (!(await exists(SB_PATH))) {
    log(`[init] downloading core -> ${SB_PATH}`);
    await downloadWithCurl(sb, SB_PATH);
  } else {
    log(`[init] core exists -> ${SB_PATH}`);
  }

  if (!(await exists(CF_PATH))) {
    log(`[init] downloading cloudflared -> ${CF_PATH}`);
    await downloadWithCurl(cf, CF_PATH);
  } else {
    log(`[init] cloudflared exists -> ${CF_PATH}`);
  }
}

function buildConfig() {
  // 核心只监听本机 + 面板唯一端口；cloudflared 再把它暴露出去
  return {
    log: { disabled: true },
    inbounds: [
      {
        tag: 'vmess-ws',
        type: 'vmess',
        listen: '127.0.0.1',
        listen_port: PANEL_PORT,
        users: [{ uuid: UUID }],
        transport: { type: 'ws', path: WS_PATH }
      }
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { rules: [], final: 'direct' }
  };
}

function buildVmessNode(domain) {
  const json = {
    v: '2',
    ps: NAME,
    add: domain,
    port: '443',
    id: UUID,
    aid: '0',
    net: 'ws',
    type: 'none',
    host: domain,
    path: WS_PATH,
    tls: 'tls',
    sni: domain
  };
  return `vmess://${Buffer.from(JSON.stringify(json)).toString('base64')}`;
}

function extractTryDomain(line) {
  const m = line.match(/https?:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
  return m && m[1] ? m[1] : '';
}

function childEnv() {
  // 避免 cloudflared 在 /home/container 写多余配置；但二进制仍在 /home/container/bin
  const env = { ...process.env };
  env.HOME = '/tmp'; // 小文件写到 /tmp
  env.XDG_CONFIG_HOME = '/tmp/xdg/config';
  env.XDG_CACHE_HOME = '/tmp/xdg/cache';
  env.XDG_DATA_HOME = '/tmp/xdg/data';
  return env;
}

function startCore() {
  const p = spawn(SB_PATH, ['run', '-c', CFG_PATH], {
    cwd: BIN_DIR,
    env: childEnv(),
    stdio: ['ignore', 'ignore', 'pipe']
  });

  p.stderr.on('data', d => {
    const s = d.toString('utf8').trim();
    if (s) log(`[core] ${s}`);
  });

  p.on('exit', (code, sig) => log(`[core] exited code=${code} sig=${sig || ''}`));
  log(`[init] core started 127.0.0.1:${PANEL_PORT} ws=${WS_PATH}`);
  return p;
}

function startArgo() {
  const args = [
    'tunnel',
    '--edge-ip-version', 'auto',
    '--no-autoupdate',
    '--protocol', 'http2',
    '--url', `http://127.0.0.1:${PANEL_PORT}`
  ];

  const p = spawn(CF_PATH, args, {
    cwd: BIN_DIR,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const onLine = (buf) => {
    const s = buf.toString('utf8');
    s.split(/\r?\n/).forEach((line) => {
      if (!line) return;

      if (!printed) {
        const d = extractTryDomain(line);
        if (d) {
          printed = true;
          log(`[init] argo domain = ${d}`);
          log(`[node] ${buildVmessNode(d)}`);
          log(`[note] 复制上面这一行 vmess:// 到客户端即可`);
        }
      }
    });
  };

  // trycloudflare 域名经常在 stderr 输出，所以两边都解析
  p.stdout.on('data', onLine);
  p.stderr.on('data', onLine);

  p.on('exit', (code, sig) => log(`[argo] exited code=${code} sig=${sig || ''}`));
  return p;
}

async function main() {
  if (!UUID || UUID.includes('把这里换成')) {
    die('[fatal] 你没有把 HARD_UUID 改成真实 UUID。');
  }

  // 先清理，避免磁盘超限（你无法手动 rm）
  await cleanupHeavyFiles();

  // 下载（到 /home/container/bin）
  await ensureBinaries();

  // 写配置（很小）
  await fs.promises.writeFile(CFG_PATH, JSON.stringify(buildConfig()), 'utf8');

  startCore();
  startArgo();

  // 保活，避免面板误判“无输出=卡死”
  setInterval(() => log('[keep] alive'), 30000).unref();
}

main().catch(e => die(e && e.stack ? e.stack : String(e)));

