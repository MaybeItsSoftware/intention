import fs from 'node:fs';
import path from 'node:path';

// App Store review screenshots render an HTML page with setContent, where
// relative font URLs do not resolve. Embed the shipped Arvo files instead.
export function fontFaceCss(fontsDir) {
  const dataUrl = name => {
    const buf = fs.readFileSync(path.join(fontsDir, name));
    return `data:font/woff2;base64,${buf.toString('base64')}`;
  };
  return `
    @font-face { font-family: 'Arvo'; font-style: normal; font-weight: 400; src: url('${dataUrl('Arvo-Regular.woff2')}') format('woff2'); }
    @font-face { font-family: 'Arvo'; font-style: normal; font-weight: 700; src: url('${dataUrl('Arvo-Bold.woff2')}') format('woff2'); }
    @font-face { font-family: 'Arvo'; font-style: italic; font-weight: 400; src: url('${dataUrl('Arvo-Italic.woff2')}') format('woff2'); }
    @font-face { font-family: 'Arvo'; font-style: italic; font-weight: 700; src: url('${dataUrl('Arvo-BoldItalic.woff2')}') format('woff2'); }
  `;
}
