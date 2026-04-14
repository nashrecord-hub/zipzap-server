const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const tmpDir = '/tmp/zipzap';
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpDir),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

const deleteAfter = (filePath, ms = 3600000) => {
  setTimeout(() => { try { fs.unlinkSync(filePath); } catch(e) {} }, ms);
};

app.post('/convert/audio', upload.single('file'), async (req, res) => {
  const { format } = req.body;
  const inputPath = req.file.path;
  const outputPath = path.join(tmpDir, Date.now() + '.' + format);
  ffmpeg(inputPath).toFormat(format)
    .on('end', () => res.download(outputPath, `converted.${format}`, () => { deleteAfter(inputPath, 1000); deleteAfter(outputPath, 1000); }))
    .on('error', (err) => res.status(500).json({ error: err.message }))
    .save(outputPath);
});

app.post('/convert/video', upload.single('file'), async (req, res) => {
  const { format } = req.body;
  const inputPath = req.file.path;
  const outputPath = path.join(tmpDir, Date.now() + '.' + format);
  ffmpeg(inputPath).toFormat(format)
    .on('end', () => res.download(outputPath, `converted.${format}`, () => { deleteAfter(inputPath, 1000); deleteAfter(outputPath, 1000); }))
    .on('error', (err) => res.status(500).json({ error: err.message }))
    .save(outputPath);
});

app.post('/convert/extract-audio', upload.single('file'), async (req, res) => {
  const { format = 'mp3' } = req.body;
  const inputPath = req.file.path;
  const outputPath = path.join(tmpDir, Date.now() + '.' + format);
  ffmpeg(inputPath).noVideo().toFormat(format)
    .on('end', () => res.download(outputPath, `audio.${format}`, () => { deleteAfter(inputPath, 1000); deleteAfter(outputPath, 1000); }))
    .on('error', (err) => res.status(500).json({ error: err.message }))
    .save(outputPath);
});

app.post('/convert/image', upload.single('file'), async (req, res) => {
  const { format, quality = 80, width, height } = req.body;
  const inputPath = req.file.path;
  const outputPath = path.join(tmpDir, Date.now() + '.' + format);
  try {
    let s = sharp(inputPath);
    if (width || height) s = s.resize(width ? parseInt(width) : null, height ? parseInt(height) : null, { fit: 'inside', withoutEnlargement: true });
    if (format === 'jpeg' || format === 'jpg') s = s.jpeg({ quality: parseInt(quality) });
    else if (format === 'png') s = s.png({ quality: parseInt(quality) });
    else if (format === 'webp') s = s.webp({ quality: parseInt(quality) });
    await s.toFile(outputPath);
    res.download(outputPath, `converted.${format}`, () => { deleteAfter(inputPath, 1000); deleteAfter(outputPath, 1000); });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/pdf/merge', upload.array('files'), async (req, res) => {
  try {
    const mergedPdf = await PDFDocument.create();
    for (const file of req.files) {
      const pdf = await PDFDocument.load(fs.readFileSync(file.path));
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => mergedPdf.addPage(page));
    }
    const outputPath = path.join(tmpDir, Date.now() + '_merged.pdf');
    fs.writeFileSync(outputPath, await mergedPdf.save());
    res.download(outputPath, 'merged.pdf', () => { req.files.forEach(f => deleteAfter(f.path, 1000)); deleteAfter(outputPath, 1000); });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/pdf/split', upload.single('file'), async (req, res) => {
  try {
    const { pages } = req.body;
    const pdf = await PDFDocument.load(fs.readFileSync(req.file.path));
    const newPdf = await PDFDocument.create();
    let pageNumbers = pages ? pages.split(',').flatMap(p => p.includes('-') ? Array.from({length: parseInt(p.split('-')[1]) - parseInt(p.split('-')[0]) + 1}, (_, i) => parseInt(p.split('-')[0]) - 1 + i) : [parseInt(p) - 1]) : pdf.getPageIndices();
    const copiedPages = await newPdf.copyPages(pdf, pageNumbers);
    copiedPages.forEach(page => newPdf.addPage(page));
    const outputPath = path.join(tmpDir, Date.now() + '_split.pdf');
    fs.writeFileSync(outputPath, await newPdf.save());
    res.download(outputPath, 'split.pdf', () => { deleteAfter(req.file.path, 1000); deleteAfter(outputPath, 1000); });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/pdf/compress', upload.single('file'), async (req, res) => {
  try {
    const pdf = await PDFDocument.load(fs.readFileSync(req.file.path));
    const outputPath = path.join(tmpDir, Date.now() + '_compressed.pdf');
    fs.writeFileSync(outputPath, await pdf.save({ useObjectStreams: true }));
    res.download(outputPath, 'compressed.pdf', () => { deleteAfter(req.file.path, 1000); deleteAfter(outputPath, 1000); });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/pdf/images-to-pdf', upload.array('files'), async (req, res) => {
  try {
    const pdfDoc = await PDFDocument.create();
    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase();
      let imageBytes;
      if (ext === '.jpg' || ext === '.jpeg') {
        imageBytes = fs.readFileSync(file.path);
        const image = await pdfDoc.embedJpg(imageBytes);
        const page = pdfDoc.addPage([image.width, image.height]);
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      } else if (ext === '.png') {
        imageBytes = fs.readFileSync(file.path);
        const image = await pdfDoc.embedPng(imageBytes);
        const page = pdfDoc.addPage([image.width, image.height]);
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      } else {
        const jpegBuffer = await sharp(file.path).jpeg().toBuffer();
        const image = await pdfDoc.embedJpg(jpegBuffer);
        const page = pdfDoc.addPage([image.width, image.height]);
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      }
    }
    const outputPath = path.join(tmpDir, Date.now() + '_output.pdf');
    fs.writeFileSync(outputPath, await pdfDoc.save());
    res.download(outputPath, 'images.pdf', () => { req.files.forEach(f => deleteAfter(f.path, 1000)); deleteAfter(outputPath, 1000); });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/pdf/pdf-to-images', upload.single('file'), async (req, res) => {
  const outputDir = path.join(tmpDir, Date.now() + '_pages');
  fs.mkdirSync(outputDir, { recursive: true });
  exec(`pdftoppm -jpeg -r 150 "${req.file.path}" "${outputDir}/page"`, (err) => {
    if (err) return res.status(500).json({ error: 'pdftoppm error' });
    const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.jpg'));
    if (!files.length) return res.status(500).json({ error: 'No pages extracted' });
    res.download(path.join(outputDir, files[0]), 'page1.jpg', () => { deleteAfter(req.file.path, 1000); });
  });
});

app.post('/pdf/word-to-pdf', upload.single('file'), async (req, res) => {
  const inputPath = req.file.path;
  exec(`libreoffice --headless --convert-to pdf "${inputPath}" --outdir "${tmpDir}"`, (err) => {
    if (err) return res.status(500).json({ error: 'LibreOffice error' });
    const outputPath = inputPath.replace(/\.[^/.]+$/, '.pdf');
    res.download(outputPath, 'converted.pdf', () => { deleteAfter(inputPath, 1000); deleteAfter(outputPath, 1000); });
  });
});

app.get('/', (req, res) => res.json({ status: 'ZipZap Converter API running! 🚀', version: '1.0.0' }));

app.listen(PORT, () => console.log(`ZipZap Server running on port ${PORT}`));
