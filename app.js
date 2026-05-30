const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
// Convert any image (including HEIC) to JPG using sharp
async function convertToJpg(filePath) {
  try {
    const tmpPath = filePath + '_tmp.jpg';
    await sharp(filePath)
      .rotate()
      .jpeg({ quality: 88 })
      .toFile(tmpPath);
    fs.unlinkSync(filePath);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('Image conversion error:', err.message);
  }
}

// ─── Database ─────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'blog.json');

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      posts: [],
      gallery: [],
      admin: { username: 'admin', password: bcrypt.hashSync('admin123', 10) }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  if (!data.posts)   data.posts   = [];
  if (!data.gallery) data.gallery = [];
  if (!data.admin)   data.admin   = { username: 'admin', password: bcrypt.hashSync('admin123', 10) };
  return data;
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

readDB();

// ─── App ──────────────────────────────────────────────────────────
const app = express();
app.set('view engine', 'ejs');
app.set('views', './views');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ secret: 'snapsnack-secret-key', resave: false, saveUninitialized: false }));

// ─── Uploads ──────────────────────────────────────────────────────
const postStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const galleryStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/gallery-uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const uploadPost    = multer({ storage: postStorage,    limits: { fileSize: 10 * 1024 * 1024 } });

// Helper to process inline images in content
function processInlineImages(content, files) {
  if (!files || files.length === 0) return content;
  let result = content;
  files.forEach(file => {
    // Replace all variations of the tag
    const tag1 = '[image:' + file.fieldname + ']';
    const tag2 = '[image: ' + file.fieldname + ']';
    const imgPath = '/uploads/' + file.filename;
    result = result.split(tag1).join('[image:' + imgPath + ']');
    result = result.split(tag2).join('[image:' + imgPath + ']');
  });
  return result;
}
const uploadGallery = multer({ storage: galleryStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Helpers ──────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/admin/login');
}
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
}
function formatDate(d) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Render post content — converts markdown-like tags to HTML
function renderContent(text) {
  if (!text) return '';
  let html = text
    // Inline images: [image:/uploads/xxx.jpg]
    .replace(/\[image:([^\]]+)\]/g, '</p><img src="$1" alt="Post image" class="inline-post-img"><p>')
    // Headings
    .replace(/^### (.+)$/gm, '<h3 class="post-h3">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="post-h2">$1</h2>')
    // Horizontal rule
    .replace(/^---$/gm, '<hr class="post-hr">')
    // Blockquote
    .replace(/^> (.+)$/gm, '<blockquote class="post-quote">$1</blockquote>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Line breaks
    .replace(/\n/g, '<br>')
.replace(/<br>\[image:/g, '[image:')
.replace(/\[image:[^\]]+\]<br>/g, '');
  return html;
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  const db = readDB();
  let posts = [...db.posts].filter(p => p.status !== 'draft').reverse();
  // Pinned post always first
  const pinned = posts.find(p => p.pinned);
  if (pinned) {
    posts = [pinned, ...posts.filter(p => !p.pinned)];
  }
  const latestPhotos = [...db.gallery].reverse().slice(0, 6);
  const categories = [...new Set(db.posts.filter(p => p.status !== 'draft').map(p => p.category))];
  res.render('home', { posts, latestPhotos, categories });
});

app.get('/blog', (req, res) => {
  const db = readDB();
  const { category, search } = req.query;
  let posts = [...db.posts].filter(p => p.status !== 'draft').reverse();
  if (category) posts = posts.filter(p => p.category === category);
  if (search) posts = posts.filter(p =>
    p.title.toLowerCase().includes(search.toLowerCase()) ||
    p.content.toLowerCase().includes(search.toLowerCase())
  );
  const categories = [...new Set(db.posts.filter(p => p.status !== 'draft').map(p => p.category))];
  res.render('blog', { posts, categories, activeCategory: category || '', search: search || '' });
});

app.get('/post/:slug', (req, res) => {
  const db = readDB();
  const post = db.posts.find(p => p.slug === req.params.slug && p.status !== 'draft');
  if (!post) return res.status(404).render('404');
  if (!post.comments) post.comments = [];
  // View counter
  post.views = (post.views || 0) + 1;
  writeDB(db);
  const related = db.posts.filter(p => p.slug !== post.slug && p.category === post.category && p.status !== 'draft').slice(0, 3);
  // Reading time
  const words = post.content.split(/\s+/).length;
  const readTime = Math.max(1, Math.round(words / 200));
  res.render('post', { post, related, readTime, renderContent });
});

app.post('/post/:slug/comment', (req, res) => {
  const { name, email, comment } = req.body;
  if (!name || !comment) return res.redirect('/post/' + req.params.slug);
  const db = readDB();
  const post = db.posts.find(p => p.slug === req.params.slug);
  if (!post) return res.redirect('/');
  if (!post.comments) post.comments = [];
  post.comments.push({
    id: Date.now(),
    name: name.trim(),
    email: email ? email.trim() : '',
    comment: comment.trim(),
    date: formatDate(new Date())
  });
  writeDB(db);
  res.redirect('/post/' + req.params.slug + '#comments');
});

app.get('/gallery', (req, res) => {
  const db = readDB();
  const photos = [...db.gallery].reverse();
  res.render('gallery', { photos });
});

app.get('/about',   (req, res) => res.render('about'));
app.get('/contact', (req, res) => res.render('contact', { success: false }));

app.post('/contact', (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) return res.render('contact', { success: false });
  const db = readDB();
  if (!db.messages) db.messages = [];
  db.messages.push({
    id: Date.now(),
    name: name.trim(),
    email: email.trim(),
    message: message.trim(),
    date: formatDate(new Date()),
    read: false
  });
  writeDB(db);
  res.render('contact', { success: true });
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/admin/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const db = readDB();
  const { username, password } = req.body;
  if (username === db.admin.username && bcrypt.compareSync(password, db.admin.password)) {
    req.session.loggedIn = true;
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: 'Wrong username or password.' });
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

app.get('/admin', requireLogin, (req, res) => {
  const db = readDB();
  const published = db.posts.filter(p => p.status !== 'draft').reverse();
  const drafts    = db.posts.filter(p => p.status === 'draft').reverse();
  const messages  = (db.messages || []).filter(m => !m.read).length;
  res.render('admin/dashboard', {
    posts: published,
    drafts,
    photoCount: db.gallery.length,
    unreadMessages: messages
  });
});

// Create post
app.get('/admin/new', requireLogin, (req, res) => res.render('admin/form', { post: null, error: null }));

app.post('/admin/new', requireLogin, uploadPost.any(), async (req, res) => {
  const { title, action } = req.body;
  let { content, category, tags } = req.body;
  if (!title || !content) return res.render('admin/form', { post: null, error: 'Title and content are required.' });
  const files = req.files || [];
  // Convert all uploaded images to JPG (handles HEIC/HEIF)
  await Promise.all(files.map(f => convertToJpg(f.path)));
  const featuredFile = files.find(f => f.fieldname === 'image');
  const inlineFiles  = files.filter(f => f.fieldname !== 'image');
  content = processInlineImages(content, inlineFiles);
  const db = readDB();
  db.posts.push({
    id: Date.now(),
    title,
    content,
    category: category || 'Travel',
    tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    image: featuredFile ? '/uploads/' + featuredFile.filename : null,
    date: formatDate(new Date()),
    slug: slugify(title),
    status: action === 'draft' ? 'draft' : 'published',
    comments: []
  });
  writeDB(db);
  res.redirect('/admin');
});

// Edit post
app.get('/admin/edit/:id', requireLogin, (req, res) => {
  const db = readDB();
  const post = db.posts.find(p => p.id === Number(req.params.id));
  if (!post) return res.redirect('/admin');
  res.render('admin/form', { post, error: null });
});

app.post('/admin/edit/:id', requireLogin, uploadPost.any(), async (req, res) => {
  const { title, action } = req.body;
  let { content, category, tags } = req.body;
  const db = readDB();
  const post = db.posts.find(p => p.id === Number(req.params.id));
  if (!post) return res.redirect('/admin');
  const files = req.files || [];
  // Convert all uploaded images to JPG (handles HEIC/HEIF)
  await Promise.all(files.map(f => convertToJpg(f.path)));
  const featuredFile = files.find(f => f.fieldname === 'image');
  const inlineFiles  = files.filter(f => f.fieldname !== 'image');
  content = processInlineImages(content, inlineFiles);
  post.title    = title;
  post.content  = content;
  post.category = category || 'Travel';
  post.tags     = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  post.status   = action === 'draft' ? 'draft' : 'published';
  if (featuredFile) post.image = '/uploads/' + featuredFile.filename;
  writeDB(db);
  res.redirect('/admin');
});

// Publish a draft
app.post('/admin/publish/:id', requireLogin, (req, res) => {
  const db = readDB();
  const post = db.posts.find(p => p.id === Number(req.params.id));
  if (post) { post.status = 'published'; writeDB(db); }
  res.redirect('/admin');
});


// Pin / unpin post
app.post('/admin/pin/:id', requireLogin, (req, res) => {
  const db = readDB();
  db.posts.forEach(p => p.pinned = false);
  const post = db.posts.find(p => p.id === Number(req.params.id));
  if (post) post.pinned = true;
  writeDB(db);
  res.redirect('/admin');
});

app.post('/admin/unpin/:id', requireLogin, (req, res) => {
  const db = readDB();
  const post = db.posts.find(p => p.id === Number(req.params.id));
  if (post) post.pinned = false;
  writeDB(db);
  res.redirect('/admin');
});

// Delete post
app.post('/admin/delete/:id', requireLogin, (req, res) => {
  const db = readDB();
  db.posts = db.posts.filter(p => p.id !== Number(req.params.id));
  writeDB(db);
  res.redirect('/admin');
});

// Delete comment
app.post('/admin/comment/delete/:postId/:commentId', requireLogin, (req, res) => {
  const db = readDB();
  const post = db.posts.find(p => p.id === Number(req.params.postId));
  if (post && post.comments) {
    post.comments = post.comments.filter(c => c.id !== Number(req.params.commentId));
    writeDB(db);
  }
  res.redirect('/admin');
});

// Gallery
app.get('/admin/gallery', requireLogin, (req, res) => {
  const db = readDB();
  res.render('admin/gallery', { photos: [...db.gallery].reverse() });
});

app.post('/admin/gallery/upload', requireLogin, uploadGallery.array('photos', 20), async (req, res) => {
  const db = readDB();
  const { captions } = req.body;
  // Convert all uploaded images to JPG (handles HEIC/HEIF)
  await Promise.all(req.files.map(f => convertToJpg(f.path)));
  req.files.forEach((file, i) => {
    db.gallery.push({
      id: Date.now() + i,
      src: '/gallery-uploads/' + file.filename,
      caption: Array.isArray(captions) ? (captions[i] || '') : (captions || ''),
      date: formatDate(new Date())
    });
  });
  writeDB(db);
  res.redirect('/admin/gallery');
});

app.post('/admin/gallery/edit/:id', requireLogin, (req, res) => {
  const db = readDB();
  const photo = db.gallery.find(p => p.id === Number(req.params.id));
  if (photo) { photo.caption = req.body.caption || ''; writeDB(db); }
  res.redirect('/admin/gallery');
});

app.post('/admin/gallery/delete/:id', requireLogin, (req, res) => {
  const db = readDB();
  db.gallery = db.gallery.filter(p => p.id !== Number(req.params.id));
  writeDB(db);
  res.redirect('/admin/gallery');
});

// Messages
app.get('/admin/messages', requireLogin, (req, res) => {
  const db = readDB();
  const messages = [...(db.messages || [])].reverse();
  messages.forEach(m => m.read = true);
  writeDB(db);
  res.render('admin/messages', { messages });
});

app.post('/admin/messages/delete/:id', requireLogin, (req, res) => {
  const db = readDB();
  db.messages = (db.messages || []).filter(m => m.id !== Number(req.params.id));
  writeDB(db);
  res.redirect('/admin/messages');
});

// ─── Change password ──────────────────────────────────────────────
app.get('/admin/password', requireLogin, (req, res) => {
  res.render('admin/password', { error: null, success: false });
});

app.post('/admin/password', requireLogin, (req, res) => {
  const { current, newpass, confirm } = req.body;
  const db = readDB();
  if (!bcrypt.compareSync(current, db.admin.password)) {
    return res.render('admin/password', { error: 'Current password is wrong.', success: false });
  }
  if (newpass.length < 6) {
    return res.render('admin/password', { error: 'New password must be at least 6 characters.', success: false });
  }
  if (newpass !== confirm) {
    return res.render('admin/password', { error: 'New passwords do not match.', success: false });
  }
  db.admin.password = bcrypt.hashSync(newpass, 10);
  writeDB(db);
  res.render('admin/password', { error: null, success: true });
});

// ─── Start ────────────────────────────────────────────────────────
// ─── Sitemap & Robots ─────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  const db = readDB();
  const base = 'https://snapandsnack-production.up.railway.app';
  const posts = db.posts.filter(p => p.status !== 'draft');
  let xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/9/sitemap.xsd">
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
app.listen(3000, () => {
  console.log('');
  console.log('  ✅  Snap & Snack is live!');
  console.log('  🌍  Your blog  →  http://localhost:3000');
  console.log('  🔧  Admin      →  http://localhost:3000/admin');
  console.log('  🔑  Login: admin / admin123');
  console.log('');
});
