const form=document.querySelector('#brand-form'),name=document.querySelector('#brand-name'),tagline=document.querySelector('#brand-tagline'),status=document.querySelector('#brand-status'),images={};
const encoder=new TextEncoder();
function preview(){
 document.querySelector('#preview-name').textContent=name.value;
 document.querySelector('#preview-tagline').textContent=tagline.value;
 for(const canvas of document.querySelectorAll('[data-preview]')){
  const ctx=canvas.getContext('2d'),size=canvas.width,image=images[canvas.dataset.preview];ctx.clearRect(0,0,size,size);
  if(image){const scale=Math.min(size/image.width,size/image.height);ctx.drawImage(image,(size-image.width*scale)/2,(size-image.height*scale)/2,image.width*scale,image.height*scale);}
  else{ctx.fillStyle='#2c3730';ctx.fillRect(0,0,size,size);ctx.fillStyle='#ffe5ad';ctx.font=`${size*.6}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('♫',size/2,size/2);}
 }
}
form.addEventListener('input',preview);
for(const input of form.querySelectorAll('[data-image]'))input.addEventListener('change',async()=>{
 const file=input.files[0];if(!file)return;
 try{if(file.size>5*1024*1024)throw Error('请选择不超过 5 MB 的图片。');
 const image=await createImageBitmap(file);if(image.width>4096||image.height>4096){image.close();throw Error('图片尺寸请控制在 4096 × 4096 以内。');}
 images[input.dataset.image]?.close();images[input.dataset.image]=image;status.textContent='图片已应用到预览。';preview();
 }catch(error){input.value='';status.textContent='图片未应用：'+error.message;}
});
for(const button of form.querySelectorAll('[data-reset]'))button.addEventListener('click',()=>{const key=button.dataset.reset;images[key]?.close();delete images[key];form.querySelector(`[data-image="${key}"]`).value='';preview();status.textContent='将沿用播放器原图标。';});
function crc32(bytes){let crc=-1;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^-1)>>>0;}
function zip(files){const parts=[],directory=[];let offset=0;
 for(const [path,bytes] of files){const file=encoder.encode(path),crc=crc32(bytes),header=new Uint8Array(30+file.length),h=new DataView(header.buffer);h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint32(14,crc,true);h.setUint32(18,bytes.length,true);h.setUint32(22,bytes.length,true);h.setUint16(26,file.length,true);header.set(file,30);parts.push(header,bytes);
 const central=new Uint8Array(46+file.length),c=new DataView(central.buffer);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint32(16,crc,true);c.setUint32(20,bytes.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,file.length,true);c.setUint32(42,offset,true);central.set(file,46);directory.push(central);offset+=header.length+bytes.length;}
 const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,directory.reduce((n,b)=>n+b.length,0),true);e.setUint32(16,offset,true);return new Blob([...parts,...directory,end],{type:'application/zip'});
}
form.addEventListener('submit',async event=>{event.preventDefault();const title=name.value.trim();if(!title||/[<>:"/\\|?*{}'\x00-\x1f]/.test(title)||/[. ]$/.test(title)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(title)){status.textContent='名称请使用 1～48 个字符，不含路径符号、引号或大括号。';return;}
 const button=document.querySelector('#brand-export');button.disabled=true;
 try{const files=[['branding/branding.json',encoder.encode(JSON.stringify({name:title,tagline:tagline.value},null,2))]];
 for(const key of ['app','logo','tray'])if(images[key]){const canvas=document.querySelector(`[data-preview="${key}"]`),blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('图片转换失败');const bytes=new Uint8Array(await blob.arrayBuffer());files.push([`branding/${key}.png`,bytes]);if(key==='app'){const ico=new Uint8Array(22+bytes.length),v=new DataView(ico.buffer);v.setUint16(2,1,true);v.setUint16(4,1,true);v.setUint16(10,1,true);v.setUint16(12,32,true);v.setUint32(14,bytes.length,true);v.setUint32(18,22,true);ico.set(bytes,22);files.push(['branding/app.ico',ico]);}}
 files.push(['使用说明.txt',encoder.encode('关闭播放器，将 branding 文件夹复制到 rustmusic.exe 同目录。未选择的图标会沿用原图标。\r\nEXE 文件图标及安装包需使用官网下载的 Windows 打包工具生成；选择品牌包中的图片即可。\r\n品牌包不包含播放器或模型，不会移除开源署名。')]);
 const url=URL.createObjectURL(zip(files)),link=document.createElement('a');link.href=url;link.download=title+'-品牌包.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);status.textContent='品牌包已生成，请查看浏览器下载。';
 }catch(error){status.textContent='生成未完成：'+error.message;}finally{button.disabled=false;}
});preview();
