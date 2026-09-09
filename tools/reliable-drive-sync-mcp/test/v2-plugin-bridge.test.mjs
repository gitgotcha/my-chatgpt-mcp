import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../stdio-bridge.mjs';

test('plugin can discover and call all six native V2 reads without creating an outbox', async () => {
  const listed = await handleRequest({id:1,method:'tools/list'});
  const storageSchema = listed.result.tools[0].inputSchema.oneOf
    .find((branch) => branch.required.includes('storageVersion'));
  const declaredOperations = storageSchema.properties.operation.enum;
  assert.deepEqual(
    ['capabilities','user.resolve','projection.read','interview.session.list','interview.session.load','event.status']
      .map((operation) => declaredOperations.includes(operation)),
    [true, true, true, true, true, true]
  );
  const context = {installationId:'11111111-1111-4111-8111-111111111111',bindingEpoch:'22222222-2222-4222-8222-222222222222',bindingRevision:0,userId:'33333333-3333-4333-8333-333333333333'};
  const operations = [['capabilities',{},null],['user.resolve',{displayName:'乔炳源'},context],['projection.read',{namespace:'algorithm',projectionName:'learning'},context],['interview.session.list',{},context],['interview.session.load',{sessionId:'s1'},context],['event.status',{targetRequestId:'r1'},context]];
  for (const [operation,params,bindingContext] of operations) {
    let calls=0;
    const result = await handleRequest({id:2,method:'tools/call',params:{name:'submit_event',arguments:{storageVersion:2,operation,params,...(bindingContext ? {bindingContext} : {})}}}, {
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
