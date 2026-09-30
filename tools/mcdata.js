const registry = require("prismarine-registry")("1.21.1");
const b = registry.blocksByName.nether_portal;
console.log("name:",b.name,"boundingBox:",b.boundingBox,"material:",b.material);
console.log("shapes:",JSON.stringify(b.shapes));
console.log("states:",JSON.stringify(b.states));
const obs = registry.blocksByName.obsidian;
console.log("obsidian boundingBox:",obs.boundingBox);