const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const db = new sqlite3.Database('./database.sqlite');

// Read schema file
const schema = fs.readFileSync('./schema.sql', 'utf8');

// Execute schema
db.exec(schema, (err) => {
    if (err) {
        console.error('Error creating schema:', err);
        process.exit(1);
    }
    console.log('✓ Database schema created');
    
    // Create demo user with proper hash
    const demoEmail = 'demo@taskweaver.com';
    const demoPassword = 'Demo@2024';
    
    bcrypt.hash(demoPassword, 10, (err, hash) => {
        if (err) {
            console.error('Error hashing password:', err);
            process.exit(1);
        }
        
        db.run(`INSERT OR REPLACE INTO users (username, email, password, reminder_interval, auto_reminders) 
                VALUES (?, ?, ?, 20, 1)`,
            ['DEMOUSER', demoEmail, hash],
            function(err) {
                if (err) {
                    console.error('Error creating demo user:', err);
                } else {
                    console.log('✓ Demo user created: demo@taskweaver.com / Demo@2024');
                }
                
                // Read and execute seed data if exists
                if (fs.existsSync('./seed.sql')) {
                    const seed = fs.readFileSync('./seed.sql', 'utf8');
                    db.exec(seed, (err) => {
                        if (err) {
                            console.error('Error seeding data:', err);
                        } else {
                            console.log('✓ Seed data loaded');
                        }
                        db.close();
                        console.log('\n✅ Database initialization complete!');
                    });
                } else {
                    db.close();
                    console.log('\n✅ Database initialization complete!');
                }
            }
        );
    });
});