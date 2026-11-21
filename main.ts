// A working gta6-cover-art-01 entry (Node 22, standard library only): the app is this directory's app/ folder, plain
// static files a desktop browser loads offline (app/index.html and its ES modules, no library and no network
// request), and the program hands it in. It copies app/ and screenshots/ from beside this file to /output and writes
// /output/dossier.json, the summary the judge reads, with the vendored make.fun library. Only the plumbing, not the
// cover art the bounty asks for: Cover Snap, a plain one-photo square cover with a sunset tint and a bold caption,
// exported as a 1080 x 1080 PNG. Its two sample photos (app/samples/) were made for make.fun with an image model and
// are free to use. Build your own GTA-style cover maker in its place, put your 3 or 4 PNG or JPEG screenshots in
// screenshots/ (the first by name is the cover) and run it.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-app.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });
cpSync(join(here, 'app'), join(out, 'app'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });

// The entry's own screenshots, checked before the dossier is written: an entry hands in 3 or 4 files, the first by
// name the cover, each at most 256 KiB. The app folder is what the bounty judges for the cover work, so a broken
// screenshots/ folder is a mistake to fail on loudly here rather than to hand in. Names come from the directory
// listing and every entry is stat'ed, so a subdirectory or a link cannot pass as a screenshot.
const SHOTS_MIN = 3;
const SHOTS_MAX = 4;
const SHOT_MAX_BYTES = 262144;
const INDEX_MAX_BYTES = 1048576;
const shotsDir = join(here, 'screenshots');
if (!existsSync(shotsDir)) throw new Error('screenshots/: missing — this entry hands in 3 or 4 PNG or JPEG renders of app/, the first by name the cover');
const shotNames = readdirSync(shotsDir).filter((name) => !name.startsWith('.'));
const shotFiles = [];
const shotDirs = [];
for (const name of shotNames) {
  const st = statSync(join(shotsDir, name));
  if (st.isDirectory()) shotDirs.push(name);
  else if (st.isFile()) shotFiles.push(name);
  else throw new Error(`screenshots/${name}: not a plain file (a symbolic link or special file): screenshots/ is 3 or 4 flat PNG or JPEG files`);
}
shotFiles.sort();
shotDirs.sort();
if (shotDirs.length > 0) throw new Error(`screenshots/: holds ${shotDirs.length} director${shotDirs.length === 1 ? 'y' : 'ies'} instead of files (${shotDirs.join(', ')}): screenshots/ is 3 or 4 flat PNG or JPEG files, the first by name the cover`);
if (shotFiles.length < SHOTS_MIN || shotFiles.length > SHOTS_MAX) {
  throw new Error(`screenshots/: holds ${shotFiles.length} file${shotFiles.length === 1 ? '' : 's'}, but this entry hands in ${SHOTS_MIN} or ${SHOTS_MAX} (${shotFiles.join(', ') || 'none'})`);
}
for (const name of shotFiles) {
  const size = statSync(join(shotsDir, name)).size;
  if (size > SHOT_MAX_BYTES) throw new Error(`screenshots/${name}: ${size} bytes, over the ${SHOT_MAX_BYTES} this entry allows`);
}

// app/index.html is the page a browser opens, and the app is nothing without it: check it exists as a file and is
// within the 1 MiB the bounty's scorer reads, so a missing or oversized page fails here with a clear message.
const indexPath = join(here, 'app', 'index.html');
if (!existsSync(indexPath)) throw new Error('app/index.html: missing — the app is a folder of static files with index.html at its root');
const indexStat = statSync(indexPath);
if (!indexStat.isFile()) throw new Error('app/index.html: not a plain file — the app is a folder of static files with index.html at its root');
if (indexStat.size > INDEX_MAX_BYTES) throw new Error(`app/index.html: ${indexStat.size} bytes, over the ${INDEX_MAX_BYTES} a page may be`);

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes the bytes; the others refuse an entry the
// scorer would refuse (more than 4 screenshots or one over 256 KiB; more than 993 files in app/ or 48 MiB of app
// files, in all, or a path under app/ over 1000 bytes: app/ counts beside /output's own 1000-entry cap, its
// screenshots/ and dossier.json).
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    app_max_files: 993,
    app_max_bytes: 50331648,
    app_path_max_bytes: 1000,
  }),
);
