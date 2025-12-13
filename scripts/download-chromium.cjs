const chromium = require('@sparticuz/chromium');

(async () => {
  try {
    const executablePath = await chromium.executablePath();
    console.log('Chromium binary ready at', executablePath);
  } catch (error) {
    console.error('Chromium download failed:', error);
    process.exit(1);
  }
})();
