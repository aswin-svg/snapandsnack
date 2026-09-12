const express = require('express');
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
let sharp;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set; sessions will be invalidated when the server restarts.');
}

// ─── Detect environment ───────────────────────────────────────────
const USE_MONGO = !!process.env.MONGODB_URI;
let Post, Gallery, Message, Admin, mongoose;

if (USE_MONGO) {
  mongoose = require('mongoose');
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('  ✅  MongoDB connected!'))
    .catch(err => console.error('  ❌  MongoDB error:', err.message));

  const PostSchema = new mongoose.Schema({
    id: Number, title: String, content: String,
    category: String, tags: [String], image: String,
    date: String, slug: String, status: String,
    pinned: Boolean, views: Number, comments: Array
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
async function convertToJpg(file) {
  if (!sharp) return; // skip if sharp not available
  try {
    const finalPath = path.join(path.dirname(file.path), path.parse(file.filename).name + '.jpg');
    const tmpPath = finalPath + '.tmp.jpg';
    await sharp(file.path).rotate().jpeg({ quality: 88 }).toFile(tmpPath);
    fs.unlinkSync(file.path);
    fs.renameSync(tmpPath, finalPath);
    file.path = finalPath;
    file.filename = path.basename(finalPath);
  } catch (err) {
    console.error('Image conversion error:', err.message);
  }
}

// ─── App ──────────────────────────────────────────────────────────
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "data:"],
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

// ─── Uploads ──────────────────────────────────────────────────────
const postStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const galleryStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/gallery-uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const imageFilter = (req, file, cb) => {
  const allowedExtensions = new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp']);
  const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  const ext = allowedExtensions.has(path.extname(file.originalname).toLowerCase());
  const mime = allowedMimes.has(file.mimetype);
  if (ext && mime) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'), false);
  }
};

const uploadPost    = multer({ storage: postStorage,    limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: imageFilter });
const uploadGallery = multer({ storage: galleryStorage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: imageFilter });

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
function safeUrl(value) {
  const url = String(value).trim();
  if (url.startsWith('/uploads/') || url.startsWith('/gallery-uploads/')) return url;
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
    const imgPath = '/uploads/' + file.filename;
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

app.get('/', async (req, res) => {
  try {
    let posts, latestPhotos, categories;
    if (USE_MONGO) {
      posts = await Post.find({ status: { $ne: 'draft' } }).sort({ id: -1 });
      const pinned = posts.find(p => p.pinned);
      if (pinned) posts = [pinned, ...posts.filter(p => !p.pinned)];
      latestPhotos = await Gallery.find().sort({ id: -1 }).limit(6);
      categories = [...new Set(posts.map(p => p.category))];
    } else {
      const db = readDB();
      posts = [...db.posts].filter(p => p.status !== 'draft').reverse();
      const pinned = posts.find(p => p.pinned);
      if (pinned) posts = [pinned, ...posts.filter(p => !p.pinned)];
      latestPhotos = [...db.gallery].reverse().slice(0, 6);
      categories = [...new Set(posts.map(p => p.category))];
    }
    res.render('home', { posts, latestPhotos, categories });
  } catch (err) { res.status(500).render('404'); }
});

app.get('/blog', async (req, res) => {
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
  } catch (err) { res.status(500).render('404'); }
});

app.get('/post/:slug', async (req, res) => {
  try {
    let post, related;
    if (USE_MONGO) {
      post = await Post.findOne({ slug: req.params.slug, status: { $ne: 'draft' } });
      if (!post) return res.status(404).render('404');
      post.views = (post.views || 0) + 1;
      await post.save();
      related = await Post.find({ slug: { $ne: post.slug }, category: post.category, status: { $ne: 'draft' } }).limit(3);
    } else {
      const db = readDB();
      post = db.posts.find(p => p.slug === req.params.slug && p.status !== 'draft');
      if (!post) return res.status(404).render('404');
      if (!post.comments) post.comments = [];
      post.views = (post.views || 0) + 1;
      writeDB(db);
      related = db.posts.filter(p => p.slug !== post.slug && p.category === post.category && p.status !== 'draft').slice(0, 3);
    }
    const words = post.content.split(/\s+/).length;
    const readTime = Math.max(1, Math.round(words / 200));
    res.render('post', { post, related, readTime, renderContent });
  } catch (err) { res.status(500).render('404'); }
});

app.post('/post/:slug/comment', commentLimiter, async (req, res) => {
  const name = cleanText(req.body.name, 80);
  const email = cleanText(req.body.email, 254);
  const comment = cleanText(req.body.comment, 2000);
  if (!name || !comment || (email && !isValidEmail(email))) return res.redirect('/post/' + req.params.slug);
  try {
    if (USE_MONGO) {
      const post = await Post.findOne({ slug: req.params.slug });
      if (!post) return res.redirect('/');
      if (!post.comments) post.comments = [];
      post.comments.push({ id: Date.now(), name, email, comment, date: formatDate(new Date()) });
      await post.save();
    } else {
      const db = readDB();
      const post = db.posts.find(p => p.slug === req.params.slug);
      if (!post) return res.redirect('/');
      if (!post.comments) post.comments = [];
      post.comments.push({ id: Date.now(), name, email, comment, date: formatDate(new Date()) });
      writeDB(db);
    }
    res.redirect('/post/' + req.params.slug + '#comments');
  } catch (err) { res.redirect('/'); }
});

app.get('/gallery', async (req, res) => {
  try {
    const photos = USE_MONGO
      ? await Gallery.find().sort({ id: -1 })
      : [...readDB().gallery].reverse();
    res.render('gallery', { photos });
  } catch (err) { res.status(500).render('404'); }
});

app.get('/tags', async (req, res) => {
  const db = readDB();
  const posts = USE_MONGO
    ? await Post.find({ status: { $ne: 'draft' } })
    : db.posts.filter(p => p.status !== 'draft');
  const tagMap = {};
  posts.forEach(post => {
    (post.tags || []).forEach(tag => {
      if (!tagMap[tag]) tagMap[tag] = [];
      tagMap[tag].push(post);
    });
  });
  res.render('tags', { tagMap });
});

app.get('/tags/:tag', async (req, res) => {
  const db = readDB();
  const allPosts = USE_MONGO
    ? await Post.find({ status: { $ne: 'draft' } })
    : db.posts.filter(p => p.status !== 'draft');
  const tag = req.params.tag;
  const posts = allPosts.filter(p => (p.tags || []).includes(tag));
  res.render('tag-posts', { tag, posts });
});

app.get('/archive', async (req, res) => {
  const db = readDB();
  const posts = USE_MONGO
    ? await Post.find({ status: { $ne: 'draft' } }).sort({ id: -1 })
    : db.posts.filter(p => p.status !== 'draft').reverse();
  const archive = {};
  posts.forEach(post => {
    const date = new Date(post.id);
    const key = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
    if (!archive[key]) archive[key] = [];
    archive[key].push(post);
  });
  res.render('archive', { archive });
});

app.post('/newsletter', newsletterLimiter, async (req, res) => {
  const email = cleanText(req.body.email, 254).toLowerCase();
  if (!isValidEmail(email)) return res.redirect('/');
  if (USE_MONGO) {
    // check if already subscribed
    const exists = await Message.findOne({ email: email.trim(), name: 'newsletter' });
    if (!exists) {
      await Message.create({
        id: Date.now(), name: 'newsletter',
        email: email.trim(), message: 'Newsletter subscriber',
        date: formatDate(new Date()), read: false
      });
    }
  } else {
    const db = readDB();
    if (!db.newsletter) db.newsletter = [];
    if (!db.newsletter.includes(email.trim())) {
      db.newsletter.push(email.trim());
      writeDB(db);
    }
  }
  res.redirect('/');
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
app.get('/contact', (req, res) => res.render('contact', { success: false }));

app.post('/contact', contactLimiter, async (req, res) => {
  const name = cleanText(req.body.name, 80);
  const email = cleanText(req.body.email, 254).toLowerCase();
  const message = cleanText(req.body.message, 5000);
  if (!name || !isValidEmail(email) || !message) return res.render('contact', { success: false });
  try {
    if (USE_MONGO) {
      await Message.create({ id: Date.now(), name, email, message, date: formatDate(new Date()), read: false });
    } else {
      const db = readDB();
      if (!db.messages) db.messages = [];
      db.messages.push({ id: Date.now(), name, email, message, date: formatDate(new Date()), read: false });
      writeDB(db);
    }
    res.render('contact', { success: true });
  } catch (err) { res.render('contact', { success: false }); }
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

app.get('/admin', requireLogin, async (req, res) => {
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
  } catch (err) { res.status(500).render('404'); }
});

app.get('/admin/new', requireLogin, (req, res) => res.render('admin/form', { post: null, error: null }));

app.post('/admin/new', requireLogin, uploadPost.any(), verifyImageUploads, async (req, res) => {
  const action = req.body.action;
  const title = cleanText(req.body.title, 160);
  let content = cleanText(req.body.content, 100000);
  const category = cleanText(req.body.category, 50);
  const tags = cleanText(req.body.tags, 500);
  if (!title || !content) return res.render('admin/form', { post: null, error: 'Title and content are required.' });
  try {
    const files = req.files || [];
    await Promise.all(files.map(convertToJpg));
    const featuredFile = files.find(f => f.fieldname === 'image');
    const inlineFiles  = files.filter(f => f.fieldname !== 'image');
    content = processInlineImages(content, inlineFiles);
    const postData = {
      id: Date.now(), title, content,
      category: category || 'Travel',
      tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      image: featuredFile ? '/uploads/' + featuredFile.filename : null,
      date: formatDate(new Date()), slug: slugify(title),
      status: action === 'draft' ? 'draft' : 'published', comments: []
    };
    if (USE_MONGO) {
      await Post.create(postData);
    } else {
      const db = readDB();
      db.posts.push(postData);
      writeDB(db);
    }
    res.redirect('/admin');
  } catch (err) { res.render('admin/form', { post: null, error: 'Error creating post.' }); }
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

app.post('/admin/edit/:id', requireLogin, uploadPost.any(), verifyImageUploads, async (req, res) => {
  const action = req.body.action;
  const title = cleanText(req.body.title, 160);
  let content = cleanText(req.body.content, 100000);
  const category = cleanText(req.body.category, 50);
  const tags = cleanText(req.body.tags, 500);
  try {
    const files = req.files || [];
    await Promise.all(files.map(convertToJpg));
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
      if (featuredFile) post.image = '/uploads/' + featuredFile.filename;
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
      if (featuredFile) post.image = '/uploads/' + featuredFile.filename;
      writeDB(db);
    }
    res.redirect('/admin');
  } catch (err) { res.redirect('/admin'); }
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
    writeDB(db);
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
  if (!reply) return res.redirect('back');
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
  res.redirect('back');
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

app.get('/admin/gallery', requireLogin, async (req, res) => {
  const photos = USE_MONGO
    ? await Gallery.find().sort({ id: -1 })
    : [...readDB().gallery].reverse();
  res.render('admin/gallery', { photos });
});

app.post('/admin/gallery/upload', requireLogin, uploadGallery.array('photos', 20), verifyImageUploads, async (req, res) => {
  const captions = req.body.captions;
  await Promise.all(req.files.map(convertToJpg));
  if (USE_MONGO) {
    for (let i = 0; i < req.files.length; i++) {
      await Gallery.create({
        id: Date.now() + i,
        src: '/gallery-uploads/' + req.files[i].filename,
        caption: Array.isArray(captions) ? (captions[i] || '') : (captions || ''),
        date: formatDate(new Date())
      });
    }
  } else {
    const db = readDB();
    req.files.forEach((file, i) => {
      db.gallery.push({
        id: Date.now() + i,
        src: '/gallery-uploads/' + file.filename,
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
  const base = 'https://snapandsnacks.com';
  const posts = USE_MONGO
    ? await Post.find({ status: { $ne: 'draft' } })
    : readDB().posts.filter(p => p.status !== 'draft');
  let xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><priority>1.0</priority></url>
  <url><loc>${base}/blog</loc><priority>0.9</priority></url>
  <url><loc>${base}/gallery</loc><priority>0.8</priority></url>
  <url><loc>${base}/about</loc><priority>0.7</priority></url>
  <url><loc>${base}/contact</loc><priority>0.6</priority></url>`;
  posts.forEach(p => {
    xml += `<url><loc>${base}/post/${p.slug}</loc><priority>0.8</priority></url>`;
  });
  xml += `</urlset>`;
  res.header('Content-Type', 'application/xml');
  res.send(xml);
});

app.get('/robots.txt', (req, res) => {
  app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  });
});
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: https://snapandsnacks.com/sitemap.xml');
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).send(err.code === 'LIMIT_FILE_SIZE' ? 'Images must be 10 MB or smaller.' : 'Invalid file upload.');
  }
  if (err) {
    console.error('Request error:', err.message);
    return res.status(400).send('Unable to process this request.');
  }
  next();
});


app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  if (USE_MONGO) {
    // Create admin if not exists
    const admin = await Admin.findOne({});
    if (!admin) await Admin.create(initialAdmin());
  }
  console.log('');
  console.log('  ✅  Snap & Snack is live!');
  console.log('  🌍  Mode: ' + (USE_MONGO ? 'MongoDB' : 'Local JSON'));
  console.log('  🌍  Your blog  →  http://localhost:' + PORT);
  console.log('  🔧  Admin      →  http://localhost:' + PORT + '/admin');
  console.log('');
});
