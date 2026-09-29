#!/usr/bin/env python3
"""Record deterministic GIFs/MP4s of FLY67 (independent of the machine's frame rate).

The page is switched to manual mode: real time is paused, the brain is advanced by exactly
1/fps of simulated time per frame, then the UI is rendered and captured. Playback speed = 1x.

  python3 -m http.server 8080 &          # from the repo root
  pip install playwright && playwright install chromium
  python3 tools/capture.py --what sixseven   # docs/sixseven.gif (3D arena, 6-7 close-up)
  python3 tools/capture.py --what brain      # docs/brain3d.gif (brain turning 360°)
  python3 tools/capture.py --what demo       # docs/demo.gif + docs/demo.mp4 (full UI)
"""
import argparse, base64, os, shutil, subprocess, tempfile
from playwright.sync_api import sync_playwright

ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']


def encode(frames_dir, fps, out_gif, width, out_mp4=None):
    pat = os.path.join(frames_dir, 'f%04d.png')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', pat, '-vf',
                    f'scale={width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];'
                    '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', out_gif], check=True)
    if out_mp4:
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', pat,
                        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                        '-crf', '24', out_mp4], check=True)


def run(url, what, out):
    tmp = tempfile.mkdtemp()
    with sync_playwright() as p:
        b = p.chromium.launch(args=ARGS)
        if what == 'sixseven':
            pg = b.new_page(viewport={'width': 1100, 'height': 1240}, device_scale_factor=2)
        else:
            pg = b.new_page(viewport={'width': 1440, 'height': 1240}, device_scale_factor=1)
        pg.goto(url)
        pg.wait_for_selector('#loading.done', timeout=180000)
        pg.wait_for_timeout(1500)
        pg.evaluate('() => { fly67.manual(true); fly67.arena.sixAuto = false; }')

        if what == 'sixseven':
            fps, n, events = 20, 120, {14: 'six'}
        elif what == 'brain':
            fps, n, events = 15, 120, {5: 'sugar', 60: 'loomL'}
            pg.evaluate('() => { const b = fly67.brainView; b.autoRotate = false; b.cam.pitch = 0.35; b.cam.dist = 2.1; }')
        else:
            fps, n, events = 10, 150, {8: 'sugar', 45: 'six', 95: 'loomL'}
        dt = 1000 / fps
        for f in range(n):
            if f in events:
                pg.evaluate(f"() => fly67.scenario('{events[f]}')")
            spin = f'fly67.brainView.cam.yaw = {f / n * 6.283185};' if what == 'brain' else ''
            pg.evaluate(f'async () => {{ await fly67.advance({dt}); {spin} fly67.render({f * dt}, {dt}); }}')
            path = os.path.join(tmp, f'f{f:04d}.png')
            if what in ('sixseven', 'brain'):
                sel = '#arena' if what == 'sixseven' else '#brain'
                data = pg.evaluate("""(sel) => {
                  const a = document.querySelector(sel), c = document.createElement('canvas');
                  c.width = a.width; c.height = a.height;
                  const x = c.getContext('2d'); x.fillStyle = '#0d111a'; x.fillRect(0, 0, c.width, c.height); x.drawImage(a, 0, 0);
                  return c.toDataURL('image/png');
                }""", sel)
                open(path, 'wb').write(base64.b64decode(data.split(',', 1)[1]))
            else:
                pg.screenshot(path=path)
            if f % 20 == 0:
                print(f'{what}: frame {f}/{n}', flush=True)
        b.close()
    os.makedirs(out, exist_ok=True)
    if what == 'sixseven':
        encode(tmp, fps, os.path.join(out, 'sixseven.gif'), 600, os.path.join(out, 'sixseven.mp4'))
    elif what == 'brain':
        encode(tmp, fps, os.path.join(out, 'brain3d.gif'), 600)
    else:
        encode(tmp, fps, os.path.join(out, 'demo.gif'), 780, os.path.join(out, 'demo.mp4'))
        shutil.copy(os.path.join(tmp, f'f{60:04d}.png'), os.path.join(out, 'screenshot.png'))
    shutil.rmtree(tmp)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://localhost:8080/')
    ap.add_argument('--what', choices=['sixseven', 'demo', 'brain'], default='demo')
    ap.add_argument('--out', default='docs')
    a = ap.parse_args()
    run(a.url, a.what, a.out)
