const fs = require('fs');

let content = fs.readFileSync('src/App.jsx', 'utf8');

// First replace UnloadButton component definition
content = content.replace(/function UnloadButton\(\{ onClick, title, className \}\) \{\s*return \(\s*<CyberButton variant="danger" className=\{className\} onClick=\{onClick\} title=\{title\}>\s*<X className="h-3 w-3 shrink-0 opacity-70" \/>\s*<span className="font-bold tracking-\[0\.2em\] text-\[9px\]">UNLOAD<\/span>\s*<\/CyberButton>\s*\);\s*\}/s, 
`function UnloadButton({ onClick, title, className }) {
  return (
    <CyberButton variant="danger" className={className} onClick={onClick} title={title}>
      <span className="font-bold tracking-[0.2em] text-[9px]">UNLOAD</span>
    </CyberButton>
  );
}`);

// This function processes one occurrence from `startIndex` onwards.
function processOccurrence(content, startIndex) {
    let btnStartIdx = content.indexOf('<div className="flex gap-0">', startIndex);
    if (btnStartIdx === -1) return { newContent: content, nextIndex: -1 };
    
    // Check if it's one of our targets (contains rounded-none border-b-0)
    let unloadIdx = content.indexOf('<UnloadButton', btnStartIdx);
    if (unloadIdx === -1) return { newContent: content, nextIndex: btnStartIdx + 10 };
    
    // if unload index is far away, we are looking at something else
    if (unloadIdx - btnStartIdx > 800) {
        return { newContent: content, nextIndex: btnStartIdx + 10 };
    }

    let btnEndIdx = content.indexOf('</div>', unloadIdx);
    let firstPart = content.slice(btnStartIdx, btnEndIdx + 6);
    
    // Only process if it has the rounded-none text
    if (!firstPart.includes('flex-1 rounded-none border-b-0')) {
        return { newContent: content, nextIndex: btnStartIdx + 10 };
    }

    // Now find the getFileLabel block that follows
    let truncateDivRegex = /\s*\{[a-zA-Z0-9_]+ \? \(\s*<div className="px-2 py-1 bg-\[var\(--mg-surface\)\] border border-\[var\(--mg-border\)\] border-t-0 rounded-\[var\(--mg-radius\)\] text-\[9px\] font-mono text-\[var\(--mg-muted\)\] truncate">\s*\{getFileLabel\([a-zA-Z0-9_]+.*?, ""\)\}\s*<\/div>\s*\) : null\}/;
    
    // We match the block directly after `firstPart`
    let remaining = content.slice(btnEndIdx + 6);
    let match = remaining.match(truncateDivRegex);
    
    let replacementLength = firstPart.length;
    let hasTruncateMatch = match && match.index === 0;
    if (hasTruncateMatch) {
       replacementLength += match[0].length;
    }

    // Rewrite firstPart
    firstPart = firstPart.replace('<div className="flex gap-0">', '<div className="flex gap-2">');
    firstPart = firstPart.replace(/className=\{([a-zA-Z0-9_]+) \? "flex-1 rounded-none border-b-0" : "w-full"\}/, 'className="flex-1"');
    
    // Extract the variable name
    let varMatch = firstPart.match(/className="flex-1"\s*([\s\S]*?)>\s*([\s\S]*?)<\/CyberButton>/);
    let condVarMatch = firstPart.match(/\{([a-zA-Z0-9_]+) \? \(/);
    let condVar = condVarMatch ? condVarMatch[1] : null;

    if (condVar) {
        firstPart = firstPart.replace(/(<CyberButton[\s\S]*?>)\s*([\s\S]*?)\s*(<\/CyberButton>)/, (m, g1, g2, g3) => {
            let originalText = g2.trim();
            if (originalText.includes('{')) {
                // {dualTextureMode === "eup" ? "Select Uniform B" : "Select Livery B"}
                let changed = originalText.replace(/Select /g, 'Change ');
                return `${g1}\n                    {${condVar} ? ${changed.slice(1,-1)} : ${originalText.slice(1,-1)}}\n                  ${g3}`;
            } else {
                let changed = originalText.replace(/Select /i, 'Change ');
                return `${g1}\n                    {${condVar} ? "${changed}" : "${originalText}"}\n                  ${g3}`;
            }
        });
        
        firstPart = firstPart.replace(/className="flex-1 rounded-none border-b-0 border-l-0"/g, 'className="flex-1"');
    }

    let replacedBlock = firstPart;
    let newContent = content.slice(0, btnStartIdx) + replacedBlock + content.slice(btnStartIdx + replacementLength);
    
    return { newContent, nextIndex: btnStartIdx + replacedBlock.length };
}

let idx = 0;
while (idx !== -1) {
    let result = processOccurrence(content, idx);
    content = result.newContent;
    idx = result.nextIndex;
}

fs.writeFileSync('src/App.jsx', content);
console.log('Done replacement.');
