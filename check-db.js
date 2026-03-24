const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

console.log('Checking database structure...\n');

// Check users table columns
db.all("PRAGMA table_info(users)", (err, columns) => {
    if (err) {
        console.error('Error:', err);
    } else {
        console.log('📋 Users table columns:');
        columns.forEach(col => {
            console.log(`   ${col.name} (${col.type})`);
        });
        console.log('');
    }
    
    // Check tasks table columns
    db.all("PRAGMA table_info(tasks)", (err, columns) => {
        if (err) {
            console.error('Error:', err);
        } else {
            console.log('📋 Tasks table columns:');
            columns.forEach(col => {
                console.log(`   ${col.name} (${col.type})`);
            });
            console.log('');
        }
        
        // Check if there are any triggers
        db.all("SELECT name, sql FROM sqlite_master WHERE type='trigger'", (err, triggers) => {
            if (err) {
                console.error('Error:', err);
            } else if (triggers && triggers.length > 0) {
                console.log('🔧 Existing triggers:');
                triggers.forEach(trigger => {
                    console.log(`   ${trigger.name}`);
                });
                console.log('');
            }
            
            db.close();
        });
    });
});