# Rebuilds server/public/cv-engine.js (the CV studio's 7 templates × 4 finishes) from tools/cv/templates.js.
# Run from the repo root after changing a template:  python3 tools/cv/build.py
import json, re, os
R = os.path.dirname(os.path.abspath(__file__))
s = open(os.path.join(R, 'templates.js')).read()
logo = re.sub(r'<\?xml[^>]*\?>', '', open(os.path.join(R, 'logo.svg')).read()).strip()
s = s.replace("const MARK = require('fs').readFileSync(require('path').join(__dirname, 'logo.svg'), 'utf8');", "const MARK = " + json.dumps(logo) + ";")
s = s.replace("body{font-family:G,system-ui,sans-serif;", "body,.cvr{font-family:G,system-ui,sans-serif;")
s = s.replace("if (typeof module !== 'undefined') module.exports = { renderCV, NAMES, FINISHES: F };", "window.EJCV = { renderCV, NAMES, FINISHES: F };")
assert 'require(' not in s
open(os.path.join(R, '..', '..', 'server', 'public', 'cv-engine.js'), 'w').write("// Elite Jobs Rwanda CV templates — 7 layouts × 4 finishes. Built by tools/cv/build.py from tools/cv/templates.js. Loaded by the CV studio.\n(function () {\n'use strict';\n" + s + "\n})();\n")
print('cv-engine.js rebuilt')
