"use strict";
const index = require("./index.js");
const tokenUtil$2 = require("./token-util-BFWhTzbj.js");
function _mergeNamespaces(n, m) {
  for (var i = 0; i < m.length; i++) {
    const e = m[i];
    if (typeof e !== "string" && !Array.isArray(e)) {
      for (const k in e) {
        if (k !== "default" && !(k in n)) {
          const d = Object.getOwnPropertyDescriptor(e, k);
          if (d) {
            Object.defineProperty(n, k, d.get ? d : {
              enumerable: true,
              get: () => e[k]
            });
          }
        }
      }
    }
  }
  return Object.freeze(Object.defineProperty(n, Symbol.toStringTag, { value: "Module" }));
}
var tokenUtilExports = tokenUtil$2.requireTokenUtil();
const tokenUtil = /* @__PURE__ */ index.getDefaultExportFromCjs(tokenUtilExports);
const tokenUtil$1 = /* @__PURE__ */ _mergeNamespaces({
  __proto__: null,
  default: tokenUtil
}, [tokenUtilExports]);
exports.tokenUtil = tokenUtil$1;
