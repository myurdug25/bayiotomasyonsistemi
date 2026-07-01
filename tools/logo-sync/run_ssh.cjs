const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();
conn.on('ready', () => {
    const b64 = fs.readFileSync('c:/Users/MURAT/Desktop/NFSSOFT/powersa/apps/api/check_user.php').toString('base64');
    conn.exec(`echo ${b64} | base64 -d | php`, (err, stream) => {
        if (err) throw err;
        stream.on('close', (code, signal) => {
            conn.end();
        }).on('data', (data) => {
            console.log('OUTPUT: ' + data);
        }).stderr.on('data', (data) => {
            console.error('STDERR: ' + data);
        });
    });
}).connect({
    host: '62.72.20.30',
    port: 22,
    username: 'root',
    password: 'Bilekpay.x4322',
    readyTimeout: 20000
});
