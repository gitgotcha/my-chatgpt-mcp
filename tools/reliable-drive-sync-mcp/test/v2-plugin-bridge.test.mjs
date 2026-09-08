import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../stdio-bridge.mjs';

test('plugin can discover and call all six native V2 reads without creating an outbox', async () => {
  const listed = await handleRequest({id:1,method:'tools/list'});
  assert.deepEqual(listed.result.tools[0].inputSchema.properties.operation.enum,
    ['capabilities','user.resolve','projection.read','interview.session.list','interview.session.load','event.status']);
  const operations = [['capabilities',{}],['user.resolve',{displayName:'乔炳源'}],['projection.read',{namespace:'algorithm',projectionName:'learning'}],['interview.session.list',{}],['interview.session.load',{sessionId:'s1'}],['event.status',{targetRequestId:'r1'}]];
  for (const [operation,params] of operations) {
    let calls=0;
    const result = await handleRequest({id:2,method:'tools/call',params:{name:'submit_event',arguments:{storageVersion:2,operation,params}}}, {
      writeVersion:'v2',workerUrl:'https://test.invalid',token:'test',
      get v2Service() { throw new Error('read_must_not_create_outbox'); },
      fetchImpl: async (url,init) => {calls++;assert.equal(url,'https://test.invalid/v2/query');assert.deepEqual(JSON.parse(init.body),{storageVersion:2,operation,params});return Response.json({ok:true});}
    });
    assert.equal(result.error,undefined);assert.equal(calls,1);
  }
});

test('ordinary plugin calls cannot enqueue admin registration in V2', async () => {
  const result = await handleRequest({id:1,method:'tools/call',params:{name:'submit_event',arguments:{schemaVersion:'1.2',namespace:'system',eventType:'system.user-registered',payload:{displayName:'乔炳源'},requestId:'r1'}}}, {
    writeVersion:'v2',get v2Service(){throw new Error('must_not_create_outbox');}
  });
  assert.equal(result.error.message,'unsupported_write_type');
});
