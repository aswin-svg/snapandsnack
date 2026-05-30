const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

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

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      posts: [], gallery: [],
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

// ─── Image conversion ─────────────────────────────────────────────
async function convertToJpg(filePath) {
  try {
    const tmpPath = filePath + '_tmp.jpg';
    await sharp(filePath).rotate().jpeg({ quality: 88 }).toFile(tmpPath);
    fs.unlinkSync(filePath);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('Image conversion error:', err.message);
  }
}

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
const uploadPost    = multer({ storage: postStorage,    limits: { fileSize: 30 * 1024 * 1024 } });
const uploadGallery = multer({ storage: galleryStorage, limits: { fileSize: 30 * 1024 * 1024 } });

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
  return text
    .replace(/\[image:([^\]]+)\]/g, '</p><img src="$1" alt="Post image" class="inline-post-img"><p>')
    .replace(/^### (.+)$/gm, '<h3 class="post-h3">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="post-h2">$1</h2>')
    .replace(/^---$/gm, '<hr class="post-hr">')
    .replace(/^> (.+)$/gm, '<blockquote class="post-quote">$1</blockquote>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
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
  } catch (err) { res.status(500).send('Error: ' + err.message); }
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
  } catch (err) { res.status(500).send('Error: ' + err.message); }
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
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.post('/post/:slug/comment', async (req, res) => {
  const { name, email, comment } = req.body;
  if (!name || !comment) return res.redirect('/post/' + req.params.slug);
  try {
    if (USE_MONGO) {
      const post = await Post.findOne({ slug: req.params.slug });
      if (!post) return res.redirect('/');
      if (!post.comments) post.comments = [];
      post.comments.push({ id: Date.now(), name: name.trim(), email: email ? email.trim() : '', comment: comment.trim(), date: formatDate(new Date()) });
      await post.save();
    } else {
      const db = readDB();
      const post = db.posts.find(p => p.slug === req.params.slug);
      if (!post) return res.redirect('/');
      if (!post.comments) post.comments = [];
      post.comments.push({ id: Date.now(), name: name.trim(), email: email ? email.trim() : '', comment: comment.trim(), date: formatDate(new Date()) });
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
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.get('/about',   (req, res) => res.render('about'));
app.get('/contact', (req, res) => res.render('contact', { success: false }));

app.post('/contact', async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) return res.render('contact', { success: false });
  try {
    if (USE_MONGO) {
      await Message.create({ id: Date.now(), name: name.trim(), email: email.trim(), message: message.trim(), date: formatDate(new Date()), read: false });
    } else {
      const db = readDB();
      if (!db.messages) db.messages = [];
      db.messages.push({ id: Date.now(), name: name.trim(), email: email.trim(), message: message.trim(), date: formatDate(new Date()), read: false });
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

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    if (USE_MONGO) {
      const admin = await Admin.findOne({ username });
      if (admin && bcrypt.compareSync(password, admin.password)) {
        req.session.loggedIn = true;
        return res.redirect('/admin');
      }
    } else {
      const db = readDB();
      if (username === db.admin.username && bcrypt.compareSync(password, db.admin.password)) {
        req.session.loggedIn = true;
        return res.redirect('/admin');
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
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.get('/admin/new', requireLogin, (req, res) => res.render('admin/form', { post: null, error: null }));

app.post('/admin/new', requireLogin, uploadPost.any(), async (req, res) => {
  const { title, action } = req.body;
  let { content, category, tags } = req.body;
  if (!title || !content) return res.render('admin/form', { post: null, error: 'Title and content are required.' });
  try {
    const files = req.files || [];
    await Promise.all(files.map(f => convertToJpg(f.path)));
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

app.post('/admin/edit/:id', requireLogin, uploadPost.any(), async (req, res) => {
  const { title, action } = req.body;
  let { content, category, tags } = req.body;
  try {
    const files = req.files || [];
    await Promise.all(files.map(f => convertToJpg(f.path)));
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

app.post('/admin/gallery/upload', requireLogin, uploadGallery.array('photos', 20), async (req, res) => {
  const { captions } = req.body;
  await Promise.all(req.files.map(f => convertToJpg(f.path)));
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
  if (USE_MONGO) {
    await Gallery.findOneAndUpdate({ id: Number(req.params.id) }, { caption: req.body.caption || '' });
  } else {
    const db = readDB();
    const photo = db.gallery.find(p => p.id === Number(req.params.id));
    if (photo) { photo.caption = req.body.caption || ''; writeDB(db); }
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
  const { current, newpass, confirm } = req.body;
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
    if (newpass.length < 6) {
      return res.render('admin/password', { error: 'New password must be at least 6 characters.', success: false });
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
  const base = 'https://snapandsnack-production.up.railway.app';
  const posts = USE_MONGO
    ? await Post.find({ status: { $ne: 'draft' } })
    : readDB().posts.filter(p => p.status !== 'draft');
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

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: https://snapandsnack-production.up.railway.app/sitemap.xml');
});

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  if (USE_MONGO) {
    // Create admin if not exists
    const admin = await Admin.findOne({});
    if (!admin) await Admin.create({ username: 'admin', password: bcrypt.hashSync('admin123', 10) });
  }
  console.log('');
  console.log('  ✅  Snap & Snack is live!');
  console.log('  🌍  Mode: ' + (USE_MONGO ? 'MongoDB' : 'Local JSON'));
  console.log('  🌍  Your blog  →  http://localhost:' + PORT);
  console.log('  🔧  Admin      →  http://localhost:' + PORT + '/admin');
  console.log('');
});