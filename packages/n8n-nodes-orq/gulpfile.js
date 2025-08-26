const path = require("node:path");
const { task, src, dest } = require("gulp");

task("build:icons", copyIcons);

function copyIcons() {
  const nodeSource = path.resolve("src", "nodes", "**", "*.{png,svg}");
  const nodeDestination = path.resolve("dist", "src", "nodes");

  src(nodeSource).pipe(dest(nodeDestination));

  const credSource = path.resolve("src", "credentials", "**", "*.{png,svg}");
  const credDestination = path.resolve("dist", "src", "credentials");

  return src(credSource).pipe(dest(credDestination));
}
