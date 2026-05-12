const http = require('http');
const fs = require('fs');
const path = require('path');

const API_HOST = 'localhost';
const API_PORT = 3000;

/**
 * Add logo to a PNG file (local file or buffer)
 * @param {string|Buffer} input - File path or Buffer containing PNG data
 * @param {Object} options - Configuration options
 * @returns {Promise<Buffer>} - PNG buffer with logo added
 */
function addLogoToFile(input, options = {}) {
  return new Promise((resolve, reject) => {
    // Read file if path provided, otherwise use buffer
    const imageBuffer = typeof input === 'string' ? fs.readFileSync(input) : input;
    
    // Convert to base64
    const base64Image = imageBuffer.toString('base64');

    const payload = {
      image_base64: base64Image,
      preferred_logo: options.preferred_logo || null,  // 'white', 'blue', 'black', null for auto
      position: options.position || 'top-left',        // 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'
      logo_scale: options.logo_scale || 0.12,
      max_logo_width: options.max_logo_width || 180,
      padding: options.padding || 0.06,
      opacity: options.opacity || 1.0,
      brightness_override: options.brightness_override || null  // 'dark' or 'light'
    };

    const postData = JSON.stringify(payload);

    const requestOptions = {
      hostname: API_HOST,
      port: API_PORT,
      path: '/addlogo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 120000
    };

    const req = http.request(requestOptions, (res) => {
      const chunks = [];

      res.on('data', (chunk) => chunks.push(chunk));

      res.on('end', () => {
        const buffer = Buffer.concat(chunks);

        if (res.statusCode === 200) {
          resolve({
            buffer: buffer,
            brightness: res.headers['x-image-brightness'],
            logoUsed: res.headers['x-logo-used']
          });
        } else {
          try {
            const error = JSON.parse(buffer.toString());
            reject(new Error(error.error || 'Unknown error'));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${buffer.toString()}`));
          }
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Process PNG file and save result
 */
async function processFile(inputPath, outputPath, options = {}) {
  console.log(`Processing: ${inputPath}`);
  
  const result = await addLogoToFile(inputPath, options);
  
  fs.writeFileSync(outputPath, result.buffer);
  
  console.log(`✓ Saved to: ${outputPath}`);
  console.log(`  Brightness: ${result.brightness}`);
  console.log(`  Logo used: ${result.logoUsed}`);
  console.log(`  Size: ${result.buffer.length} bytes`);
  
  return result;
}

/**
 * Process buffer and return buffer (for n8n or other integrations)
 */
async function processBuffer(buffer, options = {}) {
  const result = await addLogoToFile(buffer, options);
  return result.buffer;
}

// ==================== N8N COMPATIBLE INTERFACE ====================

/**
 * Main function - can be called from n8n or CLI
 * Usage: node client.js <input.png> [output.png] [options]
 */
async function main() {
  const args = process.argv.slice(2);
  
  // CLI mode: node client.js input.png output.png
  if (args.length >= 1) {
    const inputFile = args[0];
    const outputFile = args[1] || `./logo_${path.basename(inputFile)}`;
    
    // Parse optional JSON options from 3rd argument
    let options = {};
    if (args[2]) {
      try {
        options = JSON.parse(args[2]);
      } catch (e) {
        console.warn('Invalid JSON options, using defaults');
      }
    }

    try {
      await processFile(inputFile, outputFile, options);
      process.exit(0);
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }
  
  // No arguments - show usage
  else {
    console.log(`
Usage: node client.js <input.png> [output.png] [options]

Examples:
  node client.js image.png                    # outputs to logo_image.png
  node client.js image.png result.png         # specify output name
  node client.js image.png out.png '{"preferred_logo":"white","position":"top-right"}'

Options (JSON format):
  preferred_logo: "white" | "blue" | "black" | null (auto)
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center"
  logo_scale: number (0.05 to 0.5, default 0.12)
  max_logo_width: number (default 180)
  padding: number (default 0.06)
  opacity: number (0.0 to 1.0, default 1.0)
  brightness_override: "dark" | "light" | null (auto)
    `);
    process.exit(0);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

// Export for use as module (n8n or other scripts)
module.exports = {
  addLogoToFile,
  processFile,
  processBuffer
};