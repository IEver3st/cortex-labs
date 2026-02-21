const fs = require('fs');

let content = fs.readFileSync('src/App.jsx', 'utf8');

// Replace UnloadButton
content = content.replace(/function UnloadButton\(\{ onClick, title, className \}\) \{\s*return \(\s*<CyberButton variant="danger" className=\{className\} onClick=\{onClick\} title=\{title\}>\s*<X className="h-3 w-3 shrink-0 opacity-70" \/>\s*<span className="font-bold tracking-\[0\.2em\] text-\[9px\]">UNLOAD<\/span>\s*<\/CyberButton>\s*\);\s*\}/s, 
`function UnloadButton({ onClick, title, className }) {
  return (
    <CyberButton variant="danger" className={className} onClick={onClick} title={title}>
      <span className="font-bold tracking-[0.2em] text-[9px]">UNLOAD</span>
    </CyberButton>
  );
}`);

// We will use a regex that matches the flex gap-0 row AND the trailing label div.
// It matches `<div className="flex gap-0"> ... </div>\s*{var ? ( <div ... truncate"> ... </div> ) : null}`
const regex = /<div className="flex gap-0">\s*<CyberButton([^>]*)>\s*(.*?)\s*<\/CyberButton>\s*\{([a-zA-Z0-9_]+)\s*\?\s*\(\s*<UnloadButton\s*className="[^"]*"\s*onClick=\{([^}]+)\}\s*title="([^"]*)"\s*\/>\s*\)\s*:\s*null\}\s*<\/div>\s*\{\3\s*\?\s*\(\s*<div[^>]*truncate">\s*\{\s*getFileLabel[^}]+\}\s*<\/div>\s*\)\s*:\s*null\s*\}/gs;

// Wait, the background image one is slightly different because onClick has a multi-line function.
// Let's use a simpler regex that just finds the gap-0 and replaces it, then separately we remove the getFileLabel.

let pass1 = content.replace(/<div className="flex gap-0">\s*<CyberButton([\s\S]*?)className=\{([^}]+)\}([\s\S]*?)>\s*([\s\S]*?)<\/CyberButton>\s*\{([a-zA-Z0-9_]+) \? \(\s*<UnloadButton[\s\S]*?onClick=\{([\s\S]*?)\}\s*title="([^"]+)"\s*\/>\s*\) : null\}\s*<\/div>/g, (match, beforeClass, condClass, afterClass, btnText, condVar, onClick, title) => {
    
    let originalText = btnText.trim();
    let changeText = "";
    if (originalText.includes('{')) {
        changeText = originalText.replace(/Select /g, 'Change ');
        originalText = originalText.slice(1, -1);
        changeText = changeText.slice(1, -1);
    } else {
        changeText = `"` + originalText.replace(/Select /i, 'Change ') + `"`;
        originalText = `"` + originalText + `"`;
    }

    // clean up onClick if needed, but we capture the whole brace contents so it's fine.
    // wait, if onClick has nested braces like {() => { a(); b(); }}, capturing it with /onClick=\{([\s\S]*?)\}\s*title/ fails if we are not careful.
    // Our regex uses `onClick=\{([\s\S]*?)\}\s*title=` which stops at `} title=`. This usually works since the `}` is right before ` title=`.
    
    let res = `<div className="flex gap-2">
                  <CyberButton\${beforeClass}className="flex-1"\${afterClass}>
                    {\${condVar} ? \${changeText} : \${originalText}}
                  </CyberButton>
                  {\${condVar} ? (
                    <UnloadButton
                      className="flex-1"
                      onClick={\${onClick}}
                      title="\${title}"
                    />
                  ) : null}
                </div>`;
    // replace literal $ with actual variables we parsed
    res = res.replace('${beforeClass}', beforeClass);
    res = res.replace('${afterClass}', afterClass);
    res = res.replace(/\$\{condVar\}/g, condVar);
    res = res.replace('${changeText}', changeText);
    res = res.replace('${originalText}', originalText);
    res = res.replace('${onClick}', onClick);
    res = res.replace('${title}', title);
    
    return res;
});

// Pass 2: remove all `{ varPath ? ( <div className="px-2 py-1 bg-[var(--mg-surface)] ... truncate"> ... </div> ) : null }`
let pass2 = pass1.replace(/\{[a-zA-Z0-9_]+ \? \(\s*<div className="px-2 py-1 bg-\[var\(--mg-surface\)\][^>]*truncate">\s*\{\s*getFileLabel\([\s\S]*?\}\s*<\/div>\s*\) : null\}\s*/g, '');

fs.writeFileSync('src/App.jsx', pass2);
console.log('Done replacement.');
