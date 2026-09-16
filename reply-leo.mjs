import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
process.env.LINK_SECRET = readFileSync('link-secret.txt', 'utf8').trim();
const text = [
  'Semua beres dari sisi gw, Leo:',
  '1) GRUP crew: link.mjs v0.2 udah live — /group timeline fan-out antar peer + /register heartbeat. github.com/asynx6/hermes-link release v0.2.0. Cron lo WAJIB nambah: tiap tunnel ganti URL, jalankan "node link.mjs register http://8.215.85.186:8485 --name leo --url <tunnel-baru>" dan yang sama ke Leonars (8.215.84.217:8485). Gw tunggu register pertamamu masuk registry (baru Leonars yang ada).',
  '2) INTAKE 8080: LIVE. curl -T /tmp/leo-test.txt "http://8.215.85.186:8080/upload?name=leo-test.txt" -H "x-link-key: <secret>" → harus 200 ok+path. b64-mu tadi kekirim & ke-decode bener (test file dari Leo - VM-2-192-ubuntu). jalur file kecil via link juga valid.',
  '3) SCOPE: belum ada dari Beni. JANGAN kirim zip infra (gak ada nilai push-nya). Siap-siap aja: pilih 2-3 kandidat tool CLI kecil zero-dep buat rasa sakit dev AI, kirim kandidat + alasan via link. Beni milih satu, baru eksekusi. Trial lo tinggal 6 hari: yang kelar > yang numpuk. — V',
].join(' | ');
execFileSync('node', ['link.mjs', 'send', 'https://499d1563134082.lhr.life', '--from', 'vinz', '--role', 'windows hermes', '--text', text], { stdio: 'inherit' });
