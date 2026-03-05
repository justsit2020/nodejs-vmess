'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PANEL_PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || '27846', 10);

// 你说环境变量不能填：把这里写死即可（必须改 UUID）
const HARD_UUID = '7efc0ddc-87dd-4c7e-b28a-f4f34441c98e';
const HARD_NAME = 'FreeCloudPanel-US';
const HARD_WS_PATH = '/FreeCloudPanel-login';

// 【修改点1】：在这里锁定版本。版本越老通常体积越小，但请注意兼容性。
const SB_VERSION = '1.8.0'; 
const CF_VERSION = '2024.1.5';

const UUID = (process.env.UUID || HARD_UUID).trim();
const NAME = (process.env.NAME || HARD_NAME).trim();
const WS_PATH_RAW = (process.env.WS_PATH || HARD_WS_PATH).trim() || '/FreeCloudPanel-login';
const WS_PATH = WS_PATH_RAW.startsWith('/') ? WS_PATH_RAW : `/${WS_PATH_RAW}`;

const BASE_DIR = '/home/container';
const BIN_DIR = path.join(BASE_DIR, 'bin');
const SB_PATH = path.join(BIN_DIR, 'web'); // 实际是 Sing-box
const CF_PATH = path.join(BIN_DIR, 'bot'); // 实际是 Cloudflared
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

// 【修改点2】：拼接 GitHub 官方的下载直链
function getOfficialUrls() {
  const arch = archTag();
  if (arch === 'arm64') {
    return {
      sbTarUrl: `https://github.com/SagerNet/sing-box/releases/download/v${SB_VERSION}/sing-box-${SB_VERSION}-linux-arm64.tar.gz`,
      sbInnerPath: `sing-box-${SB_VERSION}-linux-arm64/sing-box`, // 压缩包内二进制文件的路径
      cfUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CF_VERSION}/cloudflared-linux-arm64`
    };
  }
  return {
    sbTarUrl: `https://github.com/SagerNet/sing-box/releases/download/v${SB_VERSION}/sing-box-${SB_VERSION}-linux-amd64.tar.gz`,
    sbInnerPath: `sing-box-${SB_VERSION}-linux-amd64/sing-box`,
    cfUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CF_VERSION}/cloudflared-linux-amd64`
  };
}

async function cleanupHeavyFiles() {
  const targets = [
    path.join(BASE_DIR, 'node_modules'),
    path.join(BASE_DIR, '.npm'),
    path.join(BASE_DIR, '.runtime'),
    path.join(BASE_DIR, 'package-lock.json'),
    path.join(BASE_DIR, 'boot.log'),
    path.join(BASE_DIR, 'list.txt'),
  ];
  for (const t of targets) {
    try { await fs.promises.rm(t, { recursive: true, force: true }); } catch {}
  }
}

// 基础下载函数 (用于直接下载二进制的 cloudflared)
function downloadWithCurl(url, outPath) {
  return new Promise((resolve, reject) => {
    const tmp = `${outPath}.tmp`;
    const args = ['-L', '--fail', '--retry', '2', '--silent', '--show-error', '-o', tmp, url];
    const p = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => err += d.toString('utf8'));
    p.on('exit', async (code) => {
      if (code !== 0) return reject(new Error(`curl failed: ${err.trim()}`));
      try {
        await fs.promises.rename(tmp, outPath);
        await fs.promises.chmod(outPath, 0o755);
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

// 【修改点3】：流式下载并解压 (用于应对 64MB 极限空间)
// 直接 curl 下载流 | tar 解析提取特定文件 > 写入磁盘，不在磁盘留存 .tar.gz 压缩包
function downloadAndExtractStream(tarUrl, innerPath, outPath) {
  return new Promise((resolve, reject) => {
    const tmp = `${outPath}.tmp`;
    // 使用 shell 管道边下边解压
    const cmd = `curl -L --fail --silent --show-error "${tarUrl}" | tar -xzO "${innerPath}" > "${tmp}"`;
    
    const p = spawn(cmd, { shell: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => err += d.toString('utf8'));
    p.on('exit', async (code) => {
      if (code !== 0) return reject(new Error(`Stream extract failed: ${err.trim()}`));
      try {
        await fs.promises.rename(tmp, outPath);
        await fs.promises.chmod(outPath, 0o755);
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

async function ensureBinaries() {
  await ensureDir(BIN_DIR);
  const urls = getOfficialUrls();

  if (!(await exists(SB_PATH))) {
    log(`[init] downloading official Sing-box (v${SB_VERSION}) stream -> ${SB_PATH}`);
    await downloadAndExtractStream(urls.sbTarUrl, urls.sbInnerPath, SB_PATH);
  } else {
    log(`[init] core exists -> ${SB_PATH}`);
  }

  if (!(await exists(CF_PATH))) {
    log(`[init] downloading official Cloudflared (${CF_VERSION}) -> ${CF_PATH}`);
    await downloadWithCurl(urls.cfUrl, CF_PATH);
  } else {
    log(`[init] cloudflared exists -> ${CF_PATH}`);
  }
}

function buildConfig() {
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
    v: '2', ps: NAME, add: domain, port: '443', id: UUID,
    aid: '0', net: 'ws', type: 'none', host: domain,
    path: WS_PATH, tls: 'tls', sni: domain
  };
  return `vmess://${Buffer.from(JSON.stringify(json)).toString('base64')}`;
}

function extractTryDomain(line) {
  const m = line.match(/https?:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
  return m && m[1] ? m[1] : '';
}

function childEnv() {
  const env = { ...process.env };
  env.HOME = '/tmp'; 
  env.XDG_CONFIG_HOME = '/tmp/xdg/config';
  env.XDG_CACHE_HOME = '/tmp/xdg/cache';
  env.XDG_DATA_HOME = '/tmp/xdg/data';
  return env;
}

function startCore() {
  const p = spawn(SB_PATH, ['run', '-c', CFG_PATH], {
    cwd: BIN_DIR, env: childEnv(), stdio: ['ignore', 'ignore', 'pipe']
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
    'tunnel', '--edge-ip-version', 'auto', '--no-autoupdate',
    '--protocol', 'http2', '--url', `http://127.0.0.1:${PANEL_PORT}`
  ];
  const p = spawn(CF_PATH, args, {
    cwd: BIN_DIR, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe']
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
        }
      }
    });
  };
  p.stdout.on('data', onLine);
  p.stderr.on('data', onLine);
  p.on('exit', (code, sig) => log(`[argo] exited code=${code} sig=${sig || ''}`));
  return p;
}

async function main() {
  if (!UUID || UUID.includes('把这里换成')) {
    die('[fatal] 你没有把 HARD_UUID 改成真实 UUID。');
  }
  await cleanupHeavyFiles();
  await ensureBinaries();
  await fs.promises.writeFile(CFG_PATH, JSON.stringify(buildConfig()), 'utf8');
  startCore();
  startArgo();
  setInterval(() => log('[keep] alive'), 30000).unref();
}

main().catch(e => die(e && e.stack ? e.stack : String(e)));
