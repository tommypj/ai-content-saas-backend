// Quick test script to verify the AI provider exports
const ai = require('./src/providers/ai');

console.log('AI Provider exports:', Object.keys(ai));
console.log('generateMeta function exists:', typeof ai.generateMeta === 'function');
console.log('generateImage function exists:', typeof ai.generateImage === 'function'); 
console.log('generateHashtags function exists:', typeof ai.generateHashtags === 'function');
