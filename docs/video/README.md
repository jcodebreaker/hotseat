# Demo video and banner

`scene.html` is the walkthrough as a deterministic timeline: `window.render(t)` draws the frame for second `t`. `render.mjs` drives headless Chrome over the DevTools protocol, one screenshot per frame.

```sh
node docs/video/render.mjs frames "file://$PWD/docs/video/scene.html" /tmp/frames 24 31 1280 720 1.5
ffmpeg -framerate 24 -i /tmp/frames/f%05d.png -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart docs/img/demo.mp4
ffmpeg -framerate 24 -i /tmp/frames/f%05d.png -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse" docs/img/demo.gif
node docs/video/render.mjs shot "file://$PWD/docs/video/og.html" docs/img/og.png 300 1280 640 2
```

Needs Google Chrome and ffmpeg.
