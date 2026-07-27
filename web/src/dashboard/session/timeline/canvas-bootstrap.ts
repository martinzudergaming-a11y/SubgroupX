const NS = "oiia-canvas";

const SCRIPT = `(function(){try{
  var NS=${JSON.stringify(NS)};
  var SEL='input,textarea,select,[contenteditable=""],[contenteditable=true],details,[aria-pressed],[aria-selected],[aria-checked],[aria-expanded],[data-state]';
  function clamp(s){s=String(s==null?"":s);return s.length>200?s.slice(0,200):s;}
  function txt(el){return clamp((el.textContent||"").replace(/\\s+/g," ").trim());}
  function labelOf(el){
    var l=el.getAttribute&&el.getAttribute("aria-label");
    if(!l&&el.labels&&el.labels[0])l=el.labels[0].textContent;
    if(!l)l=el.getAttribute&&(el.getAttribute("placeholder")||el.getAttribute("name")||el.getAttribute("data-label")||el.id);
    if(!l)l=txt(el);
    return clamp((l||"").replace(/\\s+/g," ").trim()).slice(0,80);
  }
  function pathOf(el){
    var parts=[],node=el,depth=0;
    while(node&&node.nodeType===1&&node!==document.body&&depth<6){
      var seg=node.tagName.toLowerCase(),p=node.parentNode;
      if(p){var same=[],i=0;for(;i<p.children.length;i++)if(p.children[i].tagName===node.tagName)same.push(p.children[i]);
        if(same.length>1)seg+=":nth-of-type("+(same.indexOf(node)+1)+")";}
      parts.unshift(seg);node=p;depth++;
    }
    return parts.join(">");
  }
  function keyOf(el){
    if(el.id)return"#"+el.id;
    var tag=el.tagName.toLowerCase(),type=(el.getAttribute("type")||"").toLowerCase();
    var nm=el.getAttribute&&el.getAttribute("name");
    if(nm){
      // Checkboxes share a name but are independent — key each by its value so the group doesn't
      // collapse to the first control. Radios are a single-choice group → key by the name alone
      // (only the checked one is captured). Everything else keyed by name.
      if(tag==="input"&&type==="checkbox")return"@"+nm+"#"+(el.value||pathOf(el));
      return"@"+nm;
    }
    // No id/name → a generated path. NOT the visible label: a toggle button whose text flips on
    // interaction ("Show"→"Hide") would otherwise get a new key each snapshot and misreport a state
    // change as a brand-new control. The path is stable across text changes.
    return"~"+pathOf(el);
  }
  function fieldOf(el){
    var tag=el.tagName.toLowerCase();
    var type=(el.getAttribute("type")||"").toLowerCase();
    // Accessible widget state first (a toggle button IS an <button aria-pressed>, not an input).
    if(el.hasAttribute("aria-pressed"))return{kind:"toggle",value:el.getAttribute("aria-pressed")==="true"};
    if(el.hasAttribute("aria-checked"))return{kind:"toggle",value:el.getAttribute("aria-checked")==="true"};
    if(el.hasAttribute("aria-selected"))return{kind:"toggle",value:el.getAttribute("aria-selected")==="true"};
    if(el.hasAttribute("aria-expanded"))return{kind:"state",value:el.getAttribute("aria-expanded")==="true"};
    if(tag==="details")return{kind:"state",value:!!el.open};
    if(tag==="textarea")return{kind:"note",value:clamp(el.value)};
    if(tag==="select"){
      if(el.multiple){var vs=[],o=el.options,j=0;for(;j<o.length;j++)if(o[j].selected)vs.push(o[j].value);return{kind:"select",value:vs};}
      return{kind:"select",value:el.value};
    }
    if(tag==="input"){
      if(type==="password")return null; // never capture secrets
      // Also skip credential/OTP/payment fields flagged via autocomplete, even if not type=password.
      var ac=(el.getAttribute("autocomplete")||"").toLowerCase();
      if(/(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-name)/.test(ac))return null;
      if(type==="checkbox")return{kind:"toggle",value:!!el.checked};
      if(type==="radio")return el.checked?{kind:"select",value:el.value}:null; // only the picked option
      if(type==="button"||type==="submit"||type==="reset"||type==="file"||type==="image")return null;
      return{kind:"text",value:clamp(el.value)};
    }
    if(el.isContentEditable)return{kind:"note",value:clamp(el.innerText||el.textContent)};
    if(el.hasAttribute("data-state"))return{kind:"state",value:clamp(el.getAttribute("data-state"))};
    return null;
  }
  function snapshot(){
    var out=[],idx={},els=document.querySelectorAll(SEL),i=0;
    for(;i<els.length&&out.length<120;i++){
      var el=els[i];
      if(el.disabled||(el.closest&&el.closest("[hidden]")))continue;
      var f=fieldOf(el);if(!f)continue;
      var key=keyOf(el),entry={key:key,label:labelOf(el),kind:f.kind,value:f.value};
      // Distinct keys by construction; on a genuine same-key collision, REPLACE (last wins) rather
      // than dropping the control or pushing a duplicate entry.
      if(Object.prototype.hasOwnProperty.call(idx,key))out[idx[key]]=entry;
      else{idx[key]=out.length;out.push(entry);}
    }
    return out;
  }
  var last="";
  function push(phase){
    var fields=snapshot();
    var s=JSON.stringify(fields);
    if(phase!=="init"&&s===last)return; // nothing actually changed
    last=s;
    try{window.parent.postMessage({ns:NS,type:phase,title:document.title||"",fields:fields},"*");}catch(e){}
  }
  // User edits capture on their OWN short trailing timer (input/change/click), so a high-frequency
  // MutationObserver storm from an ANIMATED canvas can never starve them.
  var ut;function userSchedule(){clearTimeout(ut);ut=setTimeout(function(){push("update");},150);}
  document.addEventListener("input",userSchedule,true);
  document.addEventListener("change",userSchedule,true);
  document.addEventListener("click",userSchedule,true);
  // The observer watches ONLY accessible-state attributes (never childList/characterData/style), so
  // animation DOM/text churn doesn't trigger it; its debounce is independent of the user timer.
  var mt;function mSchedule(){clearTimeout(mt);mt=setTimeout(function(){push("update");},300);}
  try{new MutationObserver(mSchedule).observe(document.documentElement,{attributes:true,attributeFilter:["aria-pressed","aria-selected","aria-checked","aria-expanded","data-state","open"],subtree:true});}catch(e){}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){push("init");});
  else push("init");
}catch(e){}})();`;

export function canvasBootstrapScript(): string {
  return `<script>${SCRIPT}</script>`;
}

export const CANVAS_MSG_NS = NS;

export interface CanvasFrameMessage {
  ns: typeof NS;
  type: "init" | "update";
  title: string;
  fields: { key: string; label: string; kind: string; value: string | number | boolean | string[] }[];
}
