const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { exec } = require('child_process');
const crypto = require('crypto');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_UKKlZdxRhas3wHdg0lOcKY4lJZjM8Jjy';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';

app.use(cors());
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

// accessCodes now stored in Supabase

function generateCode(plan) {
  return 'ZIPZAP-' + plan.toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function sendEmail(to, code, plan) {
  console.log('EMAIL:', to, 'CODE:', code, 'PLAN:', plan);
  if (!SENDGRID_API_KEY) return;
  const emailData = JSON.stringify({
    personalizations: [{ to: [{ email: to }] }],
    from: { email: 'noreply@zipzapconverter.com', name: 'ZipZap Converter' },
    subject: `Votre code acces ZipZap ${plan}`,
    content: [{
      type: 'text/html',
      value: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:40px;background:#080a0f;color:#f0f2f7;border-radius:16px;"><h1 style="color:#f0c040;">ZipZap Converter</h1><p>Bienvenue dans le plan ${plan}!</p><div style="background:#151820;border:2px solid #f0c040;border-radius:12px;padding:24px;text-align:center;margin:24px 0;"><div style="font-size:24px;font-weight:800;color:#f0c040;letter-spacing:3px;">${code}</div></div><a href="https://zipzapconverter.com" style="display:block;background:#f0c040;color:#000;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:700;">Activer maintenant</a></div>`
    }]
  });
  const options = { hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST', headers: { 'Authorization': `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' } };
  const req = https.request(options);
  req.on('error', (e) => console.error('Email error:', e));
  req.write(emailData);
  req.end();
}

app.post('/webhook/stripe', (req, res) => {
  let event;
  try { event = JSON.parse(req.body.toString()); } catch (err) { return res.status(400).send('Error'); }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    const amount = session.amount_total;
    let plan = 'PRO';
    if (amount >= 799) plan = 'BUSINESS';
    const code = generateCode(plan);
    await supabase.from('access_codes').insert({ code, email, plan });
    console.log('New subscriber:', email, 'Code:', code);
    sendEmail(email, code, plan);
  }
  res.json({ received: true });
});

app.post('/validate-code', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false });
  const { data, error } = await supabase.from('access_codes').select('*').eq('code', code.toUpperCase().trim()).eq('active', true).single();
  if (error || !data) return res.json({ valid: false, error: 'Code invalide' });
  res.json({ valid: true, plan: data.plan, email: data.email });
});

const tmpDir = '/tmp/zipzap';
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
const storage = multer.diskStorage({ destination: (req, file, cb) => cb(null, tmpDir), filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname) });
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });
const deleteAfter = (filePath, ms = 3600000) => { setTimeout(() => { try { fs.unlinkSync(filePath); } catch(e) {} }, ms); };

app.post('/convert/audio', upload.single('file'), async (req, res) => {
  const { format } = req.body; const inputPath = req.file.path; const outputPath = path.join(tmpDir, Date.now() + '.' + format);
  ffmpeg(inputPath).toFormat(format).on('end', () => res.download(outputPath, `converted.${format}`, () => { deleteAfter(inputPath, 1000); deleteAfter(outputPath, 1000); })).on('error', (err) => res.status(500).json({ error: err.message })).save(outputPath);
});

app.post('/convert/video', upload.single('file'), async (req, res) => {
  const { format } = req.body; const inputPath = req.file.path; const outputPath = path.join(tmpDir, Date.now() + '.' + format);
  ffmpeg(inputPath).toFormat(format).on('end', () => res.download(outputPath, `converted.${format}`, () => { deleteAfter(inputPath, 1000); deleteAfter(outputPath, 1000); })).on('error', (err) => res.status(500).json({ error: err.message })).save(outputPath);
});

app.post('/convert/extract-audio', upload.single('file'), async (req, res) => {
  const { format = 'mp3' } = req.body; const inputPath = req.file.path; const outputPath = path.join(tmpDir, Date.now() + '.' + format);
  ffmpeg(inputPath).noVideo().toFormat(format).on('end', () => res.download(outputPath, `audio.${format}`, () => { deleteAfter(inputPath, 1000); deleteAfter(outputPath, 1000); })).on('error', (err) => res.status(500).json({ error: err.message })).save(outputPath);
});

app.post('/convert/image', upload.single('file'), async (req, res) => {
  const { format, quality = 80, width, height } = req.body; const inputPath = req.file.path; const outputPath = path.join(tmpDir, Date.now() + '.' + format);
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
    for (const file of req.files) { const pdf = await PDFDocument.load(fs.readFileSync(file.path)); const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices()); pages.forEach(page => mergedPdf.addPage(page)); }
    const outputPath = path.join(tmpDir, Date.now() + '_merged.pdf');
    fs.writeFileSync(outputPath, await mergedPdf.save());
    res.download(outputPath, 'merged.pdf', () => { req.files.forEach(f => deleteAfter(f.path, 1000)); deleteAfter(outputPath, 1000); });
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

app.post('/pdf/image-to-pdf', upload.single('file'), async (req, res) => {
  try {
    const pdfDoc = await PDFDocument.create();
    const ext = path.extname(req.file.originalname).toLowerCase();
    let image;
    if (ext === '.jpg' || ext === '.jpeg') image = await pdfDoc.embedJpg(fs.readFileSync(req.file.path));
    else image = await pdfDoc.embedPng(await sharp(req.file.path).png().toBuffer());
    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    const outputPath = path.join(tmpDir, Date.now() + '_output.pdf');
    fs.writeFileSync(outputPath, await pdfDoc.save());
    res.download(outputPath, 'converted.pdf', () => { deleteAfter(req.file.path, 1000); deleteAfter(outputPath, 1000); });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/pdf/images-to-pdf', upload.array('files'), async (req, res) => {
  try {
    const pdfDoc = await PDFDocument.create();
    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase();
      let image;
      if (ext === '.jpg' || ext === '.jpeg') image = await pdfDoc.embedJpg(fs.readFileSync(file.path));
      else if (ext === '.png') image = await pdfDoc.embedPng(fs.readFileSync(file.path));
      else image = await pdfDoc.embedJpg(await sharp(file.path).jpeg().toBuffer());
      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
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
    if (!files.length) return res.status(500).json({ error: 'No pages' });
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

app.post('/convert/document', upload.single('file'), async (req, res) => {
  const inputPath = req.file.path;
  exec(`libreoffice --headless --convert-to pdf "${inputPath}" --outdir "${tmpDir}"`, (err) => {
    if (err) return res.status(500).json({ error: 'LibreOffice error' });
    const outputPath = inputPath.replace(/\.[^/.]+$/, '.pdf');
    res.download(outputPath, 'converted.pdf', () => { deleteAfter(inputPath, 1000); deleteAfter(outputPath, 1000); });
  });
});

app.get('/', (req, res) => res.json({ status: 'ZipZap Converter API running! 🚀', version: '2.0.0' }));
app.listen(PORT, () => console.log(`ZipZap Server running on port ${PORT}`));
