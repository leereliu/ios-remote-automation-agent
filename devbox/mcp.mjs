import {createInterface} from 'node:readline';
import {configuration, operation, observedOperation} from './queue-client.mjs';
const coordinate={type:'number',minimum:0,maximum:3000};
const stepSchema={oneOf:[
  {type:'object',properties:{action:{const:'tap'},args:{type:'object',properties:{x:coordinate,y:coordinate},required:['x','y'],additionalProperties:false}},required:['action','args'],additionalProperties:false},
  {type:'object',properties:{action:{const:'swipe'},args:{type:'object',properties:{from_x:coordinate,from_y:coordinate,to_x:coordinate,to_y:coordinate,duration:{type:'number',minimum:0.05,maximum:5}},required:['from_x','from_y','to_x','to_y'],additionalProperties:false}},required:['action','args'],additionalProperties:false},
  {type:'object',properties:{action:{const:'wait'},args:{type:'object',properties:{duration_ms:{type:'integer',minimum:0,maximum:2000}},required:['duration_ms'],additionalProperties:false}},required:['action','args'],additionalProperties:false},
]};
const tools = [
  ['ipad_status', 'Read the iPad automation status.', 'status', {}],
  ['ipad_screenshot', 'Take a current iPad screenshot. Image pixels correspond to device point coordinates.', 'screenshot', {}],
  ['ipad_read_screen', 'Read the current screen accessibility XML.', 'source', {}],
  ['ipad_home', 'Return the iPad to its Home screen.', 'home', {}],
  ['ipad_foreground', 'Identify the foreground application.', 'foreground', {}],
  ['ipad_launch_app', 'Launch an installed application by bundle identifier.', 'launch', {bundle_id:{type:'string'}}],
  ['ipad_tap', 'Tap an observed coordinate and return an immediate screenshot. For auto-hiding video controls, optional reveal_x/reveal_y first tap the video to reveal controls immediately before the target tap.', 'tap', {x:{type:'number',minimum:0,maximum:3000},y:{type:'number',minimum:0,maximum:3000},reveal_x:{type:'number',minimum:0,maximum:3000},reveal_y:{type:'number',minimum:0,maximum:3000}}],
  ['ipad_swipe', 'Swipe between observed coordinates and return an immediate screenshot. Duration is the initial press time; use 0.05-0.2 for ordinary swipes. Optional reveal_x/reveal_y reveal auto-hiding video controls before dragging a seek bar.', 'swipe', {from_x:{type:'number'},from_y:{type:'number'},to_x:{type:'number'},to_y:{type:'number'},duration:{type:'number',minimum:0.05,maximum:5},reveal_x:{type:'number',minimum:0,maximum:3000},reveal_y:{type:'number',minimum:0,maximum:3000}}],
  ['ipad_type', 'Enter text into the focused field. Sending or publishing requires explicit user authorization.', 'type', {text:{type:'string',maxLength:4096}}],
  ['ipad_sequence', 'Execute a preplanned sequence ON THE IPAD in one local task, then capture a screenshot and upload once. Use for transient controls: reveal tap, wait 180ms, pause or fullscreen tap, wait, drag. No model inference, cloud upload, or queue polling between steps. At most 12 tap/swipe/wait steps and eight seconds of scheduled input. In a sequence swipe duration is the MOVEMENT time in seconds; touch-down hold is 50ms. Only use coordinates observed on the current screen. An uncertain/failed sequence must never be replayed automatically.', 'sequence', {steps:{type:'array',minItems:1,maxItems:12,items:stepSchema},capture_delay_ms:{type:'integer',minimum:0,maximum:2000}}],
];
let sequence = Promise.resolve();
let operationCount = 0;
// Hosted Bot tasks may select a bounded budget; the legacy goal runner keeps 20.
const operationBudget = Number(process.env.IPAD_TOOL_BUDGET ?? 20);
if (!Number.isInteger(operationBudget) || operationBudget < 1 || operationBudget > 100) throw new Error('Invalid IPAD_TOOL_BUDGET');
const send = object => process.stdout.write(JSON.stringify(object) + '\n');
async function handle(message) {
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = {protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'private-ipad-https',version:'1.0.0'},instructions:'Only controls the configured personal iPad. No company network access or generic proxy. Never repeat an operation whose outcome is unknown.'};
  else if (message.method === 'ping') result = {};
  else if (message.method === 'tools/list') result = {tools:tools.map(([name,description,action,properties]) => ({name,description:description+(!['status','screenshot','source','foreground'].includes(action)?' Includes an immediate screenshot of the resulting screen.':''),inputSchema:{type:'object',properties,required:Object.keys(properties).filter(k=>!['duration','capture_delay_ms'].includes(k)&&!k.startsWith('reveal_')),additionalProperties:false}}))};
  else if (message.method === 'tools/call') {
    const tool = tools.find(t=>t[0]===message.params?.name);
    if (!tool) { send({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'Unknown tool'}}); return; }
    try {
      if (++operationCount > operationBudget) throw new Error('This task reached its '+operationBudget+'-operation limit. Report the current state and stop.');
      const args={...(message.params?.arguments||{})};
      if(Object.keys(args).some(key=>!Object.hasOwn(tool[3],key)))throw new Error('Unknown tool argument');
      let reveal;
      if(args.reveal_x!==undefined||args.reveal_y!==undefined){
        if(!Number.isFinite(args.reveal_x)||!Number.isFinite(args.reveal_y))throw new Error('Both reveal coordinates are required');
        reveal={x:args.reveal_x,y:args.reveal_y};delete args.reveal_x;delete args.reveal_y;
      }
      const observed=!['status','screenshot','source','foreground','sequence'].includes(tool[2]);
      const data = observed?await observedOperation(await configuration(),tool[2],args,reveal):await operation(await configuration(), tool[2],args);
      if(observed){
        const {image_base64,mime_type,...metadata}=data.observation;
        result={content:[{type:'text',text:JSON.stringify({operation:data.value,observation_id:data.observation_id,...metadata})},{type:'image',data:image_base64,mimeType:mime_type}]};
      }
      else if (['screenshot','sequence'].includes(tool[2])) {
        const {image_base64,mime_type,...metadata} = data;
        result = {content:[{type:'text',text:JSON.stringify(metadata)},{type:'image',data:image_base64,mimeType:mime_type}]};
      } else result = {content:[{type:'text',text:JSON.stringify(data)}]};
    } catch (error) { result = {isError:true,content:[{type:'text',text:error.message}]}; }
  } else { send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}}); return; }
  send({jsonrpc:'2.0',id:message.id,result});
}
createInterface({input:process.stdin}).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}}); return; }
  sequence = sequence.then(()=>handle(message)).catch(()=>send({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'MCP request failed'}}));
});
