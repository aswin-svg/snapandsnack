const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const dirs = ['public/uploads', 'public/gallery-uploads'];

async function compressAll() {
  for (const dir of dirs) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) continue;
      const filePath = path.join(dir, file);
      const size = fs.statSync(filePath).size;
      if (size < 300 * 1024) { console.log(`⏭️  Skipping ${file} (already small)`); continue; }
      const tmpPath = filePath + '_compressed.jpg';
      try {
        await sharp(filePath).rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(tmpPath);
        const newSize = fs.statSync(tmpPath).size;
        fs.unlinkSync(filePath);
        fs.renameSync(tmpPath, filePath.replace(/\.(jpg|jpeg|png|webp)$/i, '.jpg'));
        console.log(`✅ ${file}: ${(size/1024).toFixed(0)}KB → ${(newSize/1024).toFixed(0)}KB`);
      } catch(err) {
        console.error(`❌ ${file}: ${err.message}`);
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    }
  }
  console.log('\n🎉 Done!');
}

compressAll();