/* Keep the current page's work intact while explaining an excessive-IP limit. */
(() => {
  'use strict';
  let until = 0, interval = 0, page;
  function show(seconds) {
    until = Math.max(until, Date.now() + Math.max(5, Number(seconds) || 5) * 1000);
    if (!page) {
      page = document.createElement('div');
      page.setAttribute('role','alertdialog');page.setAttribute('aria-modal','true');
      page.setAttribute('aria-label','Extraordinary request activity');
      page.style.cssText='position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;background:linear-gradient(125deg,#172e32ed,#281d3af2);backdrop-filter:blur(30px);color:#f5f7fc;font:18px/1.6 inherit;padding:24px';
      const card=document.createElement('section');card.style.cssText='max-width:38rem;border:1px solid #ffffff42;border-radius:24px;background:#ffffff12;padding:32px';
      const title=document.createElement('h1');title.textContent='Please pause for a moment';title.style.fontSize='1.6rem';
      const message=document.createElement('p');message.textContent="You've been rate limited because of an extraordinary amount of requests coming from your IP address recently.";
      const button=document.createElement('button');button.type='button';button.style.cssText='border:1px solid #ffffff66;border-radius:12px;background:#ffffff18;color:inherit;font:inherit;padding:10px 18px;cursor:pointer';
      button.addEventListener('click',()=>{if(Date.now()<until)return;page.remove();page=null;clearInterval(interval);interval=0;});
      card.append(title,message,button);page.appendChild(card);document.body.appendChild(page);
      interval=setInterval(()=>{if(!page)return;const seconds=Math.max(0,Math.ceil((until-Date.now())/1000));button.disabled=seconds>0;button.textContent=seconds?'Please wait '+seconds+' seconds':'Continue where you left off';},250);
      button.focus();
    }
  }
  const original=window.fetch;
  if(original)window.fetch=async function(...args){const response=await original.apply(this,args);if(response.status===429)show(response.headers.get('Retry-After'));return response;};
  document.addEventListener('DOMContentLoaded',()=>{
    if(window.jQuery)window.jQuery(document).ajaxError((_event,response)=>{if(response.status===429)show(response.getResponseHeader('Retry-After'));});
  });
})();
