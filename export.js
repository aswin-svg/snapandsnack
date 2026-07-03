const db = require('./blog.json');
const fs = require('fs');
fs.writeFileSync('posts.json', JSON.stringify(db.posts, null, 2));
fs.writeFileSync('gallery.json', JSON.stringify(db.gallery, null, 2));
console.log('Done!');
