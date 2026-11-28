import qrcode from './vendor/qrcode-generator.cjs';

// A code the camera of the phone can read. The picture is drawn as a path of
// squares, so it stays sharp on every screen it is shown on.
export function svg(text, { margin = 4, module = 6 } = {}) {
  const code = qrcode(0, 'M');
  code.addData(String(text), 'Byte');
  code.make();
  const count = code.getModuleCount();
  const size = count + margin * 2;
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (code.isDark(row, column)) path += `M${column + margin} ${row + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * module}" height="${size * module}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`;
}

export function dataUri(text) {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg(text), 'utf8').toString('base64');
}
