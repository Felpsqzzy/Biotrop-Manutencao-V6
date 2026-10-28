const test = require('node:test');
const assert = require('node:assert/strict');
const { protectProgressWrite, protectCourseWrite } = require('../src/routes/record-security');
const user = { id: 'synthetic', perfilId: 'tecnico' };
const course = { id: 'c', status: 'publicado', quiz: { enabled: false }, sections: [{ lessons: [{ id: 'v', kind: 'video', duration: 1, min_seconds: 48 }, { id: 'pdf', kind: 'pdf', required: false }] }] };
const at = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
function write(before, n, pos, extra = {}) {
  return protectProgressWrite(user, before ? {payload: before} : null, { course_id: 'c', lessons: {v: {done: true, seconds: 999999}}, lessonHeartbeat: {lessonId: 'v', pos, playing: true}, ...extra }, 'synthetic__c', course, at(n));
}
test('video completion ignores forged seconds/done, skips, repeated calls and forged server clock', () => {
  let p = write(null, 0, 0, {_lessonHeartbeat: {lessonId:'v', at:at(-100), playing:true}});
  assert.equal(p.lessons.v.seconds, 0); assert.equal(p.lessons.v.done, false); assert.equal(p.completed_at, null);
  p = write(p, 0, 500); assert.equal(p.lessons.v.seconds, 0);
  p = write(p, 10, 10); assert.equal(p.lessons.v.seconds, 0);
  p = write(p, 20, 20); assert.equal(p.lessons.v.seconds, 10);
  p = write(p, 20, 20); assert.equal(p.lessons.v.seconds, 10);
  p = write(p, 200, 200); assert.equal(p.lessons.v.seconds, 10); assert.equal(p.completed_at, null);
});
test('normal wall-clock heartbeats complete video; explicit PDF completion stays supported', () => {
  let p = write(null, 0, 0);
  for(let n=10;n<=50;n+=10) p = write(p,n,n);
  assert.equal(p.lessons.v.seconds, 50); assert.equal(p.lessons.v.done,true); assert.ok(p.certificate_code);
  p = write(p,60,60,{lessons:{pdf:{done:true}}}); assert.equal(p.lessons.pdf.done,true);
});
test('course media rejects spoofed PDF, corrupt base64, and mismatched image signatures', () => {
  const media = value => protectCourseWrite({title:'Synthetic', sections:[{id:'s',title:'S',lessons:[{id:'l',title:'L',kind:'pdf',media:value}]}]}, 'c');
  assert.throws(()=>media('data:application/pdf;base64,'+Buffer.from('<html>synthetic</html>').toString('base64')), /conteúdo/);
  assert.throws(()=>media('data:application/pdf;base64,%%%'), /inválido/);
  assert.throws(()=>protectCourseWrite({title:'Synthetic',cover:'data:image/png;base64,'+Buffer.from('synthetic').toString('base64')},'c'), /conteúdo/);
  assert.ok(media('data:application/pdf;base64,'+Buffer.from('%PDF-1.7\nsynthetic').toString('base64')).sections[0].lessons[0].media);
});

test('legacy client-forged video completion cannot survive a write or authorize a quiz', () => {
  const { applyQuizAttempt } = require('../src/routes/record-security');
  const forged = { course_id: 'c', lessons: { v: {done:true, seconds:999999} } };
  assert.equal(write(forged,0,0).lessons.v.done,false);
  assert.throws(()=>applyQuizAttempt({...course, quiz:{enabled:true,questions:[]}},forged,{}), /Conclua/);
});
