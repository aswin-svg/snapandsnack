const express = require('express');

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

async function sendNotification(subject, html) {
  console.log('📧 Attempting to send email...', process.env.GMAIL_USER ? 'Gmail configured' : 'NO GMAIL CONFIG');
  if (!process.env.GMAIL_USER) return;
  try {
    await transporter.sendMail({
      from: '"Snap & Snacks" <' + process.env.GMAIL_USER + '>',
      to: process.env.GMAIL_USER,
      subject,
      html
    });
    console.log('📧 Notification sent!');
  } catch (err) {
    console.error('📧 Email error:', err.message);
  }
}

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Please try again after 15 minutes.'
});

const commentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many comments. Please wait a minute.'
});

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many messages. Please try again later.'
});

const newsletterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many newsletter requests. Please try again later.'
});


const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
let sharp;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const cloudinary = require('cloudinary').v2;
const cloudinaryCredentials = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME?.trim(),
  api_key: process.env.CLOUDINARY_API_KEY?.trim(),
  api_secret: process.env.CLOUDINARY_API_SECRET?.trim()
};
const USE_CLOUDINARY = Boolean(process.env.CLOUDINARY_URL || Object.values(cloudinaryCredentials).some(Boolean));
if (USE_CLOUDINARY && !process.env.CLOUDINARY_URL) {
  cloudinary.config(cloudinaryCredentials);
}

const isProduction = process.env.NODE_ENV === 'production';
const siteOrigin = new URL(process.env.SITE_URL || 'https://snapandsnacks.com').origin;
const galleryWidths = [320, 640, 960];
const galleryDirectory = path.join(__dirname, 'public', 'gallery-uploads');
const galleryFilename = /^[^./\\:\x00][^/\\:\x00]*\.(?:jpe?g|png|gif|webp)$/i;
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set; sessions will be invalidated when the server restarts.');
}

// ─── Detect environment ───────────────────────────────────────────
const USE_MONGO = !!process.env.MONGODB_URI;
let Post, Gallery, Message, Admin, mongoose;

if (USE_MONGO) {
  mongoose = require('mongoose');
  const PostSchema = new mongoose.Schema({
    id: Number, title: String, content: String,
    category: String, tags: [String], image: String,
    date: String, slug: String, status: String,
    pinned: Boolean, views: Number, comments: Array,
    metaTitle: String, metaDescription: String
  });

  const GallerySchema = new mongoose.Schema({
    id: Number, src: String, caption: String, date: String
  });
  const MessageSchema = new mongoose.Schema({
    id: Number, name: String, email: String,
    message: String, date: String, read: Boolean
  });
  const AdminSchema = new mongoose.Schema({
    username: String, password: String
  });

  Post    = mongoose.model('Post',    PostSchema);
  Gallery = mongoose.model('Gallery', GallerySchema);
  Message = mongoose.model('Message', MessageSchema);
  Admin   = mongoose.model('Admin',   AdminSchema);
}

// ─── JSON Database (local fallback) ───────────────────────────────
const DB_FILE = path.join(__dirname, 'blog.json');

function initialAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password && isProduction) {
    throw new Error('ADMIN_PASSWORD must be set before starting in production.');
  }
  if (!password) console.warn('Using the development-only default admin password. Change it before deployment.');
  return { username, password: bcrypt.hashSync(password || 'admin123', 12) };
}

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      posts: [], gallery: [],
      admin: initialAdmin()
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  if (!data.posts)   data.posts   = [];
  if (!data.gallery) data.gallery = [];
  if (!data.admin)   data.admin   = initialAdmin();
  return data;
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ─── Image conversion ─────────────────────────────────────────────
async function removeUploadFile(filePath) {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch (err) {
    console.error('Image file cleanup failed:', err.code);
  }
}

async function uploadImages(files, folder, localDirectory) {
  if (!files.length) return;
  try {
    if (USE_CLOUDINARY) {
      const { cloud_name, api_key, api_secret } = cloudinary.config();
      if (!cloud_name || !api_key || !api_secret) {
        throw new Error('Cloudinary credentials are incomplete.');
      }
    }
    for (const file of files) {
      await convertToJpg(file);
      if (USE_CLOUDINARY) {
        const result = await cloudinary.uploader.upload(file.path, { folder, resource_type: 'image' });
        if (!result.secure_url) throw new Error('Cloudinary did not return an image URL.');
        file.uploadedSrc = result.secure_url;
      } else {
        file.uploadedSrc = '/' + localDirectory + '/' + file.filename;
      }
    }
  } catch (err) {
    console.error('Image upload failed:', err.http_code || err.code || err.message);
    const uploadError = new Error('Image upload failed. Check the image and upload configuration, then try again.', { cause: err });
    uploadError.code = 'IMAGE_UPLOAD_FAILED';
    throw uploadError;
  } finally {
    if (USE_CLOUDINARY) await Promise.all(files.map(file => removeUploadFile(file.path)));
  }
}

async function convertToJpg(file) {
  if (!sharp) return; // skip if sharp not available
  const originalPath = file.path;
  const finalPath = path.join(path.dirname(originalPath), path.parse(file.filename).name + '.jpg');
  const tmpPath = finalPath + '.tmp.jpg';
  try {
    await sharp(originalPath).rotate().jpeg({ quality: 88 }).toFile(tmpPath);
    await fs.promises.rename(tmpPath, finalPath);
    file.path = finalPath;
    file.filename = path.basename(finalPath);
    if (originalPath !== finalPath) await removeUploadFile(originalPath);
  } catch (err) {
    console.error('Image conversion error:', err.message);
    await removeUploadFile(tmpPath);
  }
}

// ─── App ──────────────────────────────────────────────────────────
const app = express();
app.locals.siteUrl = pathname => siteOrigin + pathname;
app.locals.gallerySrcset = src => {
  const localPrefix = '/gallery-uploads/';
  let thumbnail;
  if (sharp && typeof src === 'string' && src.startsWith(localPrefix)) {
    let filename;
    try { filename = decodeURIComponent(src.slice(localPrefix.length)); } catch {}
    if (filename && galleryFilename.test(filename)) {
      const encodedName = encodeURIComponent(filename);
      thumbnail = width => '/gallery-thumbnails/' + width + '/' + encodedName;
    }
  }
  if (typeof src === 'string' &&
      /^https:\/\/res\.cloudinary\.com\/[\w-]+\/image\/upload\/v\d+\/[^?#]+$/.test(src)) {
    thumbnail = width => src.replace('/image/upload/', '/image/upload/c_limit,w_' + width + '/q_auto/f_auto/');
  }
  return thumbnail ? galleryWidths.map(width => thumbnail(width) + ' ' + width + 'w').join(', ') : null;
};
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.googletagmanager.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://www.google-analytics.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.urlencoded({ extended: false, limit: '100kb', parameterLimit: 100 }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', etag: true }));
app.use(session({
  name: 'snapandsnack.sid', secret: sessionSecret, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 1000 * 60 * 60 * 8 }
}));

function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}
function csrfProtection(req, res, next) {
  res.locals.csrfToken = csrfToken(req);
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const supplied = (req.body && req.body._csrf) || req.query._csrf;
  const expected = req.session.csrfToken;
  if (typeof supplied === 'string' && typeof expected === 'string' &&
      supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return next();
  }
  return res.status(403).send('Invalid or missing form token. Please refresh the page and try again.');
}
app.use('/admin', csrfProtection);
app.use((req, res, next) => {
  if (!res.locals.csrfToken) res.locals.csrfToken = csrfToken(req);
  next();
});

// ─── Uploads ──────────────────────────────────────────────────────
function imageStorage(localDirectory) {
  return multer.diskStorage({
    destination: USE_CLOUDINARY ? os.tmpdir() : path.join(__dirname, 'public', localDirectory),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
  });
}
const imageFilter = (req, file, cb) => {
  const allowedExtensions = new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp']);
  const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  const ext = allowedExtensions.has(path.extname(file.originalname).toLowerCase());
  const mime = allowedMimes.has(file.mimetype);
  if (ext && mime) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error('Only image files are allowed.'), { status: 400 }), false);
  }
};

const uploadPost    = multer({ storage: imageStorage('uploads'), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: imageFilter });
const uploadGallery = multer({ storage: imageStorage('gallery-uploads'), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: imageFilter });

// ─── Helpers ──────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/admin/login');
}
function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, maxLength) : '';
}
function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}
function isImageFile(filePath) {
  const bytes = fs.readFileSync(filePath).subarray(0, 12);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const gif = bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a';
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return jpeg || png || gif || webp;
}
function verifyImageUploads(req, res, next) {
  const files = req.files || [];
  if (files.every(file => isImageFile(file.path))) return next();
  files.forEach(file => { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); });
  return res.status(400).send('Only valid image files are allowed.');
}
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function socialImageUrl(image) {
  if (image) {
    try {
      const url = new URL(image, siteOrigin);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {
      // Use the site image if an older post has an invalid image URL.
    }
  }
  return new URL('/logo.png', siteOrigin).href;
}
function safeUrl(value) {
  const url = String(value).trim();
  if (url.startsWith('/uploads/') || url.startsWith('/gallery-uploads/')) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return url; // internal links like /post/slug, /blog, /tags/xyz
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? url : '#';
  } catch { return '#'; }
}
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
}
function formatDate(d) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function processInlineImages(content, files) {
  if (!files || files.length === 0) return content;
  let result = content;
  files.forEach(file => {
    const tag1 = '[image:' + file.fieldname + ']';
    const tag2 = '[image: ' + file.fieldname + ']';
    const imgPath = file.uploadedSrc;
    result = result.split(tag1).join('[image:' + imgPath + ']');
    result = result.split(tag2).join('[image:' + imgPath + ']');
  });
  return result;
}
function renderContent(text) {
  if (!text) return '';
  return escapeHtml(text)
    .replace(/\[image:([^\]]+)\]/g, '</p><img src="$1" alt="Photo from Snap & Snacks" class="inline-post-img" loading="lazy"><p>')
    .replace(/^#### (.+)$/gm, '<h4 class="post-h4">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 class="post-h3">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="post-h2">$1</h2>')
    .replace(/^---$/gm, '<hr class="post-hr">')
    .replace(/^> (.+)$/gm, '<blockquote class="post-quote">$1</blockquote>')
    .replace(/^• (.+)$/gm, '<li class="post-li">$1</li>')
    .replace(/^[0-9]+\. (.+)$/gm, '<li class="post-li post-li-num">$1</li>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer" class="post-link-inline">' + label + '</a>')
    .replace(/\n/g, '<br>')
    .replace(/<br>\[image:/g, '[image:')
    .replace(/\[image:[^\]]+\]<br>/g, '');
}


// ═══════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/', async (req, res, next) => {
  try {
    let posts, latestPhotos;
    if (USE_MONGO) {
      posts = await Post.find({ status: { $ne: 'draft' } }).sort({ id: -1 });
      const pinned = posts.find(p => p.pinned);
      if (pinned) posts = [pinned, ...posts.filter(p => !p.pinned)];
      latestPhotos = await Gallery.find().sort({ id: -1 }).limit(4);
    } else {
      const db = readDB();
      posts = [...db.posts].filter(p => p.status !== 'draft').reverse();
      const pinned = posts.find(p => p.pinned);
      if (pinned) posts = [pinned, ...posts.filter(p => !p.pinned)];
      latestPhotos = [...db.gallery].reverse().slice(0, 4);
    }
    res.render('home', { posts, latestPhotos });
  } catch (err) { next(err); }
});

app.get('/blog', async (req, res, next) => {
  try {
    const { category, search } = req.query;
    let posts, categories;
    if (USE_MONGO) {
      let query = { status: { $ne: 'draft' } };
      if (category) query.category = category;
      posts = await Post.find(query).sort({ id: -1 });
      if (search) posts = posts.filter(p =>
        p.title.toLowerCase().includes(search.toLowerCase()) ||
        p.content.toLowerCase().includes(search.toLowerCase())
      );
      const allPosts = await Post.find({ status: { $ne: 'draft' } });
      categories = [...new Set(allPosts.map(p => p.category))];
    } else {
      const db = readDB();
      posts = [...db.posts].filter(p => p.status !== 'draft').reverse();
      if (category) posts = posts.filter(p => p.category === category);
      if (search) posts = posts.filter(p =>
        p.title.toLowerCase().includes(search.toLowerCase()) ||
        p.content.toLowerCase().includes(search.toLowerCase())
      );
      categories = [...new Set(db.posts.filter(p => p.status !== 'draft').map(p => p.category))];
    }
    res.render('blog', { posts, categories, activeCategory: category || '', search: search || '' });
  } catch (err) { next(err); }
});

function postPath(slug) {
  return '/post/' + encodeURIComponent(slug);
}

function renderPost(res, post, options) {
  const postUrl = siteOrigin + postPath(post.slug);
  const readTime = Math.max(1, Math.round(post.content.split(/\s+/).length / 200));
  res.render('post', {
    post, postUrl, readTime, renderContent, shareImageUrl: socialImageUrl(post.image),
    related: [], generalRelated: [], categoryCounts: null, pending: false, commentError: null,
    isPreview: false, ...options
  });
}

app.get('/post/:slug', async (req, res, next) => {
  try {
    let post, related, generalRelated, categoryCounts;
    if (USE_MONGO) {
      post = await Post.findOne({ slug: req.params.slug, status: { $ne: 'draft' } });
      if (!post) return res.status(404).render('404');
      post.views = (post.views || 0) + 1;
      await post.save();
      related = await Post.find({ slug: { $ne: post.slug }, category: post.category, status: { $ne: 'draft' } }).limit(3);
      generalRelated = await Post.find({ slug: { $ne: post.slug }, status: { $ne: 'draft' } }).sort({ id: -1 }).limit(4);
      categoryCounts = {
        Travel: await Post.countDocuments({ category: 'Travel', status: { $ne: 'draft' } }),
        Food: await Post.countDocuments({ category: 'Food', status: { $ne: 'draft' } }),
        Lifestyle: await Post.countDocuments({ category: 'Lifestyle', status: { $ne: 'draft' } })
      };
    } else {
      const db = readDB();
      post = db.posts.find(p => p.slug === req.params.slug && p.status !== 'draft');
      if (!post) return res.status(404).render('404');
      if (!post.comments) post.comments = [];
      post.views = (post.views || 0) + 1;
      writeDB(db);
      related = db.posts.filter(p => p.slug !== post.slug && p.category === post.category && p.status !== 'draft').slice(0, 3);
      generalRelated = db.posts.filter(p => p.slug !== post.slug && p.status !== 'draft').reverse().slice(0, 4);
      categoryCounts = {
        Travel: db.posts.filter(p => p.category === 'Travel' && p.status !== 'draft').length,
        Food: db.posts.filter(p => p.category === 'Food' && p.status !== 'draft').length,
        Lifestyle: db.posts.filter(p => p.category === 'Lifestyle' && p.status !== 'draft').length
      };
    }
    renderPost(res, post, {
      related, generalRelated, categoryCounts, pending: req.query.pending === '1',
      commentError: req.query.commentError === 'invalid'
        ? 'Enter a name and comment within the length limits, and use a valid email address if you provide one.'
        : req.query.commentError === 'unavailable' ? 'Your comment could not be saved. Please try again.' : null
    });
  } catch (err) { next(err); }
});

app.post('/post/:slug/comment', commentLimiter, csrfProtection, async (req, res) => {
  const name = cleanText(req.body?.name, 101);
  const email = cleanText(req.body?.email, 255);
  const comment = cleanText(req.body?.comment, 2001);
  const pathToPost = postPath(req.params.slug);
  if (!name || name.length > 100 || !comment || comment.length > 2000 || (email && !isValidEmail(email))) {
    return res.redirect(303, pathToPost + '?commentError=invalid#comments');
  }
  try {
    if (USE_MONGO) {
      const post = await Post.findOne({ slug: req.params.slug, status: { $ne: 'draft' } });
      if (!post) return res.redirect('/');
      if (!post.comments) post.comments = [];
      post.comments.push({ id: Date.now(), name: name.trim(), email: email ? email.trim() : '', comment: comment.trim(), date: formatDate(new Date()), approved: false });
      await post.save();
      sendNotification(
        `💬 New comment on "${post.title}"`,
        `<h2>New comment!</h2>
        <p><strong>Post:</strong> ${escapeHtml(post.title)}</p>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email || 'Not provided')}</p>
        <p><strong>Comment:</strong> ${escapeHtml(comment)}</p>
        <p>⏳ Awaiting your approval.</p>
<a href="https://snapandsnacks.com/admin">Review in dashboard →</a>`
      );
    } else {
      const db = readDB();
      const post = db.posts.find(p => p.slug === req.params.slug && p.status !== 'draft');
      if (!post) return res.redirect('/');
      if (!post.comments) post.comments = [];
      post.comments.push({ id: Date.now(), name: name.trim(), email: email ? email.trim() : '', comment: comment.trim(), date: formatDate(new Date()), approved: false });
      writeDB(db);

      sendNotification(
  `💬 New comment on "${post.title}"`,
  `<h2>New comment!</h2>
  <p><strong>Post:</strong> ${escapeHtml(post.title)}</p>
  <p><strong>Name:</strong> ${escapeHtml(name)}</p>
  <p><strong>Email:</strong> ${escapeHtml(email || 'Not provided')}</p>
  <p><strong>Comment:</strong> ${escapeHtml(comment)}</p>
  <p>⏳ Awaiting your approval.</p>
<a href="https://snapandsnacks.com/admin">Review in dashboard →</a>`
);
    }
    res.redirect(303, pathToPost + '?pending=1#comments');
  } catch (err) {
    res.redirect(303, pathToPost + '?commentError=unavailable#comments');
  }
});

app.get('/gallery-thumbnails/:width/:filename', async (req, res, next) => {
  const { width, filename } = req.params;
  if (!galleryWidths.some(size => String(size) === width) || !galleryFilename.test(filename)) return next();
  const originalUrl = '/gallery-uploads/' + encodeURIComponent(filename);
  if (!sharp) return res.redirect(originalUrl);
  const filePath = path.join(galleryDirectory, filename);
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (err) {
    if (err.code === 'ENOENT') return next();
    throw err;
  }
  let image;
  try {
    image = await sharp(filePath).rotate().resize({ width: Number(width), withoutEnlargement: true })
      .webp({ quality: 80 }).toBuffer();
  } catch {
    return res.redirect(originalUrl);
  }
  res.set('Cache-Control', 'public, max-age=86400').type('webp').send(image);
});

app.get('/gallery', async (req, res, next) => {
  try {
    const photos = USE_MONGO
      ? await Gallery.find().sort({ id: -1 })
      : [...readDB().gallery].reverse();
    res.render('gallery', { photos });
  } catch (err) { next(err); }
});

app.get('/tags', async (req, res) => {
  const posts = USE_MONGO
    ? await Post.find({ status: { $ne: 'draft' } })
    : readDB().posts.filter(p => p.status !== 'draft');
  const tagMap = Object.create(null);
  posts.forEach(post => {
    (post.tags || []).forEach(tag => {
      if (!tagMap[tag]) tagMap[tag] = [];
      tagMap[tag].push(post);
    });
  });
  res.render('tags', { tagMap });
});

app.get('/tags/:tag', async (req, res) => {
  const allPosts = USE_MONGO
    ? await Post.find({ status: { $ne: 'draft' } })
    : readDB().posts.filter(p => p.status !== 'draft');
  const tag = req.params.tag;
  const posts = allPosts.filter(p => (p.tags || []).includes(tag));
  if (posts.length === 0) return res.status(404).render('404');
  res.render('tag-posts', { tag, posts });
});

app.get('/archive', async (req, res) => {
  const posts = USE_MONGO
    ? await Post.find({ status: { $ne: 'draft' } }).sort({ id: -1 })
    : readDB().posts.filter(p => p.status !== 'draft').reverse();
  const archive = {};
  posts.forEach(post => {
    const date = new Date(post.id);
    const key = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
    if (!archive[key]) archive[key] = [];
    archive[key].push(post);
  });
  res.render('archive', { archive });
});

app.post('/newsletter', newsletterLimiter, csrfProtection, async (req, res) => {
  const email = cleanText(req.body?.email, 255);
  const respond = (status, message) => res.status(status).type('text').send(message);
  if (!isValidEmail(email)) return respond(400, 'Enter a valid email address.');
  try {
    if (USE_MONGO) {
      const exists = await Message.findOne({ email: email.trim(), name: 'newsletter' });
      if (!exists) {
        await Message.create({
          id: Date.now(), name: 'newsletter',
          email: email.trim(), message: 'Newsletter subscriber',
          date: formatDate(new Date()), read: false
        });
        sendNotification(
          `📧 New newsletter subscriber!`,
          `<h2>New subscriber!</h2>
          <p><strong>Email:</strong> ${escapeHtml(email)}</p>
          <a href="https://snapandsnacks.com/admin/newsletter">View subscribers →</a>`
        );
      }
    } else {
      const db = readDB();
      if (!db.newsletter) db.newsletter = [];
      if (!db.newsletter.includes(email.trim())) {
        db.newsletter.push(email.trim());
        writeDB(db);
      }
    }
    return respond(200, 'Thanks! You’re on the newsletter list.');
  } catch (err) {
    return respond(503, 'Subscription is temporarily unavailable. Please try again.');
  }
});

app.get('/admin/newsletter', requireLogin, async (req, res) => {
  let subscribers;
  if (USE_MONGO) {
    const msgs = await Message.find({ name: 'newsletter' });
    subscribers = msgs.map(m => m.email);
  } else {
    const db = readDB();
    subscribers = db.newsletter || [];
  }
  res.render('admin/newsletter', { subscribers });
});

app.get('/privacy', (req, res) => res.render('privacy'));
app.get('/terms',   (req, res) => res.render('terms'));
app.get('/about',   (req, res) => res.render('about'));
app.get('/contact', (req, res) => res.render('contact', { success: false, error: null, fields: {} }));

app.post('/contact', contactLimiter, csrfProtection, async (req, res) => {
  const name = cleanText(req.body?.name, 101);
  const email = cleanText(req.body?.email, 255);
  const message = cleanText(req.body?.message, 5001);
  const fields = { name, email, message };
  if (!name || name.length > 100 || !isValidEmail(email) || !message || message.length > 5000) {
    return res.status(400).render('contact', {
      success: false, fields, error: 'Enter a name, a valid email address, and a message within the length limits.'
    });
  }
  try {
    if (USE_MONGO) {
      await Message.create({ id: Date.now(), name: name.trim(), email: email.trim(), message: message.trim(), date: formatDate(new Date()), read: false });
      sendNotification(
        `📩 New contact message from ${escapeHtml(name)}`,
        `<h2>New message!</h2>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Message:</strong> ${escapeHtml(message)}</p>
        <a href="https://snapandsnacks.com/admin/messages">View in admin →</a>`
      );
    } else {
      const db = readDB();
      if (!db.messages) db.messages = [];
      db.messages.push({ id: Date.now(), name: name.trim(), email: email.trim(), message: message.trim(), date: formatDate(new Date()), read: false });
      writeDB(db);
    }
    res.render('contact', { success: true });
  } catch (err) {
    res.status(503).render('contact', {
      success: false, fields, error: 'Your message could not be saved. Please try again.'
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/admin/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  try {
    if (USE_MONGO) {
      const admin = await Admin.findOne({ username });
      if (admin && bcrypt.compareSync(password, admin.password)) {
        return req.session.regenerate(err => {
          if (err) return res.render('admin/login', { error: 'Something went wrong.' });
          req.session.loggedIn = true;
          res.redirect('/admin');
        });
      }
    } else {
      const db = readDB();
      if (username === db.admin.username && bcrypt.compareSync(password, db.admin.password)) {
        return req.session.regenerate(err => {
          if (err) return res.render('admin/login', { error: 'Something went wrong.' });
          req.session.loggedIn = true;
          res.redirect('/admin');
        });
      }
    }
    res.render('admin/login', { error: 'Wrong username or password.' });
  } catch (err) { res.render('admin/login', { error: 'Something went wrong.' }); }
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

app.get('/admin', requireLogin, async (req, res, next) => {
  try {
    let posts, drafts, photoCount, unreadMessages;
    if (USE_MONGO) {
      posts    = await Post.find({ status: { $ne: 'draft' } }).sort({ id: -1 });
      drafts   = await Post.find({ status: 'draft' }).sort({ id: -1 });
      photoCount = await Gallery.countDocuments();
      unreadMessages = await Message.countDocuments({ read: false });
    } else {
      const db = readDB();
      posts    = db.posts.filter(p => p.status !== 'draft').reverse();
      drafts   = db.posts.filter(p => p.status === 'draft').reverse();
      photoCount = db.gallery.length;
      unreadMessages = (db.messages || []).filter(m => !m.read).length;
    }
    res.render('admin/dashboard', { posts, drafts, photoCount, unreadMessages });
  } catch (err) { next(err); }
});

app.get('/admin/new', requireLogin, (req, res) => res.render('admin/form', { post: null, error: null }));

app.get('/admin/preview/:id', requireLogin, async (req, res, next) => {
  res.set({
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer'
  });
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(404).render('404');
    const post = USE_MONGO
      ? await Post.findOne({ id, status: 'draft' })
      : readDB().posts.find(p => p.id === id && p.status === 'draft');
    if (!post) return res.status(404).render('404');
    renderPost(res, post, { isPreview: true });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/new', requireLogin, uploadPost.any(), verifyImageUploads, async (req, res) => {
  const action = req.body.action;
  const title = cleanText(req.body.title, 160);
  let content = cleanText(req.body.content, 100000);
    const category = cleanText(req.body.category, 50);
  const tags = cleanText(req.body.tags, 500);
  const metaTitle = cleanText(req.body.metaTitle, 70);
  const metaDescription = cleanText(req.body.metaDescription, 160);
  const files = req.files || [];
  if (!title || !content) {
    await Promise.all(files.map(file => removeUploadFile(file.path)));
    return res.render('admin/form', { post: null, error: 'Title and content are required.' });
  }
  try {
    await uploadImages(files, 'snapandsnacks-posts', 'uploads');
    const featuredFile = files.find(f => f.fieldname === 'image');
    const inlineFiles  = files.filter(f => f.fieldname !== 'image');
    content = processInlineImages(content, inlineFiles);
    const postData = {
      id: Date.now(), title, content,
      category: category || 'Travel',
      tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      image: featuredFile ? featuredFile.uploadedSrc : null,
      date: formatDate(new Date()), slug: slugify(title),
      status: action === 'draft' ? 'draft' : 'published', comments: [],
      metaTitle, metaDescription
    };
    if (USE_MONGO) {
      await Post.create(postData);
    } else {
      const db = readDB();
      db.posts.push(postData);
      writeDB(db);
    }
    res.redirect('/admin');
  } catch (err) {
    if (err.code === 'IMAGE_UPLOAD_FAILED') {
      return res.status(502).render('admin/form', { post: null, error: err.message });
    }
    res.render('admin/form', { post: null, error: 'Error creating post.' });
  }
});

app.get('/admin/edit/:id', requireLogin, async (req, res) => {
  try {
    const post = USE_MONGO
      ? await Post.findOne({ id: Number(req.params.id) })
      : readDB().posts.find(p => p.id === Number(req.params.id));
    if (!post) return res.redirect('/admin');
    res.render('admin/form', { post, error: null });
  } catch (err) { res.redirect('/admin'); }
});

app.post('/admin/edit/:id', requireLogin, uploadPost.any(), verifyImageUploads, async (req, res, next) => {
  const action = req.body.action;
  const title = cleanText(req.body.title, 160);
  let content = cleanText(req.body.content, 100000);
  const category = cleanText(req.body.category, 50);
  const tags = cleanText(req.body.tags, 500);
  const metaTitle = cleanText(req.body.metaTitle, 70);
  const metaDescription = cleanText(req.body.metaDescription, 160);
  try {
    const files = req.files || [];
    await uploadImages(files, 'snapandsnacks-posts', 'uploads');
    const featuredFile = files.find(f => f.fieldname === 'image');
    const inlineFiles  = files.filter(f => f.fieldname !== 'image');
    content = processInlineImages(content, inlineFiles);
    if (USE_MONGO) {
      const post = await Post.findOne({ id: Number(req.params.id) });
      if (!post) return res.redirect('/admin');
      post.title    = title;
      post.content  = content;
      post.category = category || 'Travel';
      post.tags     = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
            
      post.status   = action === 'draft' ? 'draft' : 'published';
      post.metaTitle = metaTitle;
      post.metaDescription = metaDescription;
      if (featuredFile) post.image = featuredFile.uploadedSrc;
      await post.save();
    } else {
      const db = readDB();
      const post = db.posts.find(p => p.id === Number(req.params.id));
      if (!post) return res.redirect('/admin');
      post.title    = title;
      post.content  = content;
      post.category = category || 'Travel';
      post.tags     = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      post.status   = action === 'draft' ? 'draft' : 'published';
      post.metaTitle = metaTitle;
      post.metaDescription = metaDescription;
      if (featuredFile) post.image = featuredFile.uploadedSrc;
      writeDB(db);
    }
    res.redirect('/admin');
  } catch (err) {
    if (err.code === 'IMAGE_UPLOAD_FAILED') return next(err);
    res.redirect('/admin');
  }
});

app.post('/admin/publish/:id', requireLogin, async (req, res) => {
  if (USE_MONGO) {
    await Post.findOneAndUpdate({ id: Number(req.params.id) }, { status: 'published' });
  } else {
    const db = readDB();
    const post = db.posts.find(p => p.id === Number(req.params.id));
    if (post) { post.status = 'published'; writeDB(db); }
  }
  res.redirect('/admin');
});

app.post('/admin/pin/:id', requireLogin, async (req, res) => {
  if (USE_MONGO) {
    await Post.updateMany({}, { pinned: false });
    await Post.findOneAndUpdate({ id: Number(req.params.id) }, { pinned: true });
  } else {
    const db = readDB();
    db.posts.forEach(p => p.pinned = false);
    const post = db.posts.find(p => p.id === Number(req.params.id));
    if (post) post.pinned = true;
    writeDB(db);
  }
  res.redirect('/admin');
});

app.post('/admin/unpin/:id', requireLogin, async (req, res) => {
  if (USE_MONGO) {
    await Post.findOneAndUpdate({ id: Number(req.params.id) }, { pinned: false });
  } else {
    const db = readDB();
    const post = db.posts.find(p => p.id === Number(req.params.id));
    if (post) { post.pinned = false; writeDB(db); }
  }
  res.redirect('/admin');
});

app.post('/admin/delete/:id', requireLogin, async (req, res) => {
  if (USE_MONGO) {
    await Post.findOneAndDelete({ id: Number(req.params.id) });
  } else {
    const db = readDB();
    db.posts = db.posts.filter(p => p.id !== Number(req.params.id));
    writeDB(db);
  }
  res.redirect('/admin');
});

app.post('/admin/comment/reply/:postId/:commentId', requireLogin, async (req, res) => {
  const reply = cleanText(req.body.reply, 2000);
  if (!reply) return res.redirect(req.get('Referrer') || '/');
  if (USE_MONGO) {
    const post = await Post.findOne({ id: Number(req.params.postId) });
    if (post) {
      const comment = post.comments.find(c => c.id === Number(req.params.commentId));
      if (comment) comment.reply = reply.trim();
      await post.save();
    }
  } else {
    const db = readDB();
    const post = db.posts.find(p => p.id === Number(req.params.postId));
    if (post) {
      const comment = post.comments.find(c => c.id === Number(req.params.commentId));
      if (comment) comment.reply = reply.trim();
      writeDB(db);
    }
  }
  res.redirect(req.get('Referrer') || '/');
});

app.post('/admin/comment/delete/:postId/:commentId', requireLogin, async (req, res) => {
  if (USE_MONGO) {
    const post = await Post.findOne({ id: Number(req.params.postId) });
    if (post) {
      post.comments = post.comments.filter(c => c.id !== Number(req.params.commentId));
      await post.save();
    }
  } else {
    const db = readDB();
    const post = db.posts.find(p => p.id === Number(req.params.postId));
    if (post && post.comments) {
      post.comments = post.comments.filter(c => c.id !== Number(req.params.commentId));
      writeDB(db);
    }
  }
  res.redirect('/admin');
});

app.post('/admin/comment/approve/:postId/:commentId', requireLogin, async (req, res) => {
  if (USE_MONGO) {
    const post = await Post.findOne({ id: Number(req.params.postId) });
    if (post) {
      const comment = post.comments.find(c => c.id === Number(req.params.commentId));
      if (comment) comment.approved = true;
      post.markModified('comments');
      await post.save();
    }
  } else {
    const db = readDB();
    const post = db.posts.find(p => p.id === Number(req.params.postId));
    if (post && post.comments) {
      const comment = post.comments.find(c => c.id === Number(req.params.commentId));
      if (comment) comment.approved = true;
      writeDB(db);
    }
  }
  res.redirect('/admin');
});

app.get('/admin/gallery', requireLogin, async (req, res) => {
  const photos = USE_MONGO
    ? await Gallery.find().sort({ id: -1 })
    : [...readDB().gallery].reverse();
  res.render('admin/gallery', { photos });
});

app.post('/admin/gallery/upload', requireLogin, uploadGallery.array('photos', 20), verifyImageUploads, async (req, res) => {
  const captions = req.body.captions;
  await uploadImages(req.files, 'snapandsnacks-gallery', 'gallery-uploads');
  const uploaded = req.files.map(file => file.uploadedSrc);

  if (USE_MONGO) {
    for (let i = 0; i < uploaded.length; i++) {
      await Gallery.create({
        id: Date.now() + i,
        src: uploaded[i],
        caption: Array.isArray(captions) ? (captions[i] || '') : (captions || ''),
        date: formatDate(new Date())
      });
    }
  } else {
    const db = readDB();
    uploaded.forEach((src, i) => {
      db.gallery.push({
        id: Date.now() + i,
        src: src,
        caption: Array.isArray(captions) ? (captions[i] || '') : (captions || ''),
        date: formatDate(new Date())
      });
    });
    writeDB(db);
  }
  res.redirect('/admin/gallery');
});

app.post('/admin/gallery/edit/:id', requireLogin, async (req, res) => {
  const caption = cleanText(req.body.caption, 250);
  if (USE_MONGO) {
    await Gallery.findOneAndUpdate({ id: Number(req.params.id) }, { caption });
  } else {
    const db = readDB();
    const photo = db.gallery.find(p => p.id === Number(req.params.id));
    if (photo) { photo.caption = caption; writeDB(db); }
  }
  res.redirect('/admin/gallery');
});

app.post('/admin/gallery/delete/:id', requireLogin, async (req, res) => {
  if (USE_MONGO) {
    await Gallery.findOneAndDelete({ id: Number(req.params.id) });
  } else {
    const db = readDB();
    db.gallery = db.gallery.filter(p => p.id !== Number(req.params.id));
    writeDB(db);
  }
  res.redirect('/admin/gallery');
});

app.get('/admin/messages', requireLogin, async (req, res) => {
  let messages;
  if (USE_MONGO) {
    messages = await Message.find().sort({ id: -1 });
    await Message.updateMany({}, { read: true });
  } else {
    const db = readDB();
    messages = [...(db.messages || [])].reverse();
    messages.forEach(m => m.read = true);
    writeDB(db);
  }
  res.render('admin/messages', { messages });
});

app.post('/admin/messages/delete/:id', requireLogin, async (req, res) => {
  if (USE_MONGO) {
    await Message.findOneAndDelete({ id: Number(req.params.id) });
  } else {
    const db = readDB();
    db.messages = (db.messages || []).filter(m => m.id !== Number(req.params.id));
    writeDB(db);
  }
  res.redirect('/admin/messages');
});

app.get('/admin/password', requireLogin, (req, res) => {
  res.render('admin/password', { error: null, success: false });
});

app.post('/admin/password', requireLogin, async (req, res) => {
  const current = typeof req.body.current === 'string' ? req.body.current : '';
  const newpass = typeof req.body.newpass === 'string' ? req.body.newpass : '';
  const confirm = typeof req.body.confirm === 'string' ? req.body.confirm : '';
  try {
    let currentHash;
    if (USE_MONGO) {
      const admin = await Admin.findOne({});
      currentHash = admin.password;
    } else {
      currentHash = readDB().admin.password;
    }
    if (!bcrypt.compareSync(current, currentHash)) {
      return res.render('admin/password', { error: 'Current password is wrong.', success: false });
    }
    if (newpass.length < 12) {
      return res.render('admin/password', { error: 'New password must be at least 12 characters.', success: false });
    }
    if (newpass !== confirm) {
      return res.render('admin/password', { error: 'New passwords do not match.', success: false });
    }
    const hashed = bcrypt.hashSync(newpass, 10);
    if (USE_MONGO) {
      await Admin.findOneAndUpdate({}, { password: hashed });
    } else {
      const db = readDB();
      db.admin.password = hashed;
      writeDB(db);
    }
    res.render('admin/password', { error: null, success: true });
  } catch (err) { res.render('admin/password', { error: 'Something went wrong.', success: false }); }
});

// ─── Sitemap & Robots ─────────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  const posts = USE_MONGO
    ? await Post.find({ status: { $ne: 'draft' } }).select('slug')
    : readDB().posts.filter(p => p.status !== 'draft');
  const paths = ['/', '/blog', '/gallery', '/about', '/contact', '/tags', '/archive'];
  const urls = paths.concat(posts.filter(post => post.slug).map(post => postPath(post.slug)));
  const entries = urls.map(url => '<url><loc>' + escapeHtml(siteOrigin + url) + '</loc></url>').join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`);
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ' + siteOrigin + '/sitemap.xml\n');
});

app.get('/health', (req, res) => {
  const ready = !USE_MONGO || mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'unavailable',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.use((req, res) => res.status(404).render('404'));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.code === 'IMAGE_UPLOAD_FAILED') return res.status(502).send(err.message);
  if (err instanceof multer.MulterError) {
    return res.status(400).send(err.code === 'LIMIT_FILE_SIZE' ? 'Images must be 10 MB or smaller.' : 'Invalid file upload.');
  }
  const status = err.status;
  if (status === 404) return res.status(404).render('404');
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).send('Unable to process this request.');
  }
  console.error('Request failed:', err.code || err.name);
  res.status(500).render('500');
});

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
async function start() {
  if (USE_MONGO) {
    await mongoose.connect(process.env.MONGODB_URI);
    const admin = await Admin.findOne({});
    if (!admin) await Admin.create(initialAdmin());
  }
  app.listen(PORT, () => {
    console.log('  ✅  Snap & Snack is live!');
    console.log('  🌍  Mode: ' + (USE_MONGO ? 'MongoDB' : 'Local JSON'));
    console.log('  🌍  Your blog  →  http://localhost:' + PORT);
    console.log('  🔧  Admin      →  http://localhost:' + PORT + '/admin');
  });
}
start().catch(async err => {
  console.error('Startup failed:', err.name);
  if (USE_MONGO) await mongoose.disconnect();
  process.exitCode = 1;
});
