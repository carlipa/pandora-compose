const fs = require('fs');

setTimeout(() => {
  fs.readFile('/etc/hosts', 'utf-8', (err, file) => {
    if (err) {
      console.error(err);
    }
    console.log('hosts: ', file);
  });
  fs.readFile('/etc/hostname', 'utf-8', (err, file) => {
    if (err) {
      console.error(err);
    }
    console.log('hostname: ', file);
  });
}, 100);

setInterval(() => {
  process.stdout.write('test\n');
}, 1000);

console.log(process.env);

setTimeout(() => null, 1000000);
