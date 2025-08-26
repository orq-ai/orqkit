import fs from "node:fs";
import path from "node:path";

copyIcons();

function copyIcons() {
	copyIconsFromDir("src/nodes", "dist/src/nodes");
	copyIconsFromDir("src/credentials", "dist/src/credentials");
}

function copyIconsFromDir(srcDir: string, destDir: string) {
	if (!fs.existsSync(srcDir)) {
		return;
	}

	function walkDir(dir: string) {
		const files = fs.readdirSync(dir);
		
		for (const file of files) {
			const srcPath = path.join(dir, file);
			const stat = fs.statSync(srcPath);
			
			if (stat.isDirectory()) {
				walkDir(srcPath);
			} else if (file.endsWith(".png") || file.endsWith(".svg")) {
				const relativePath = path.relative(srcDir, srcPath);
				const destPath = path.join(destDir, relativePath);
				const destFileDir = path.dirname(destPath);
				
				if (!fs.existsSync(destFileDir)) {
					fs.mkdirSync(destFileDir, { recursive: true });
				}
				
				fs.copyFileSync(srcPath, destPath);
				console.log(`Copied ${srcPath} to ${destPath}`);
			}
		}
	}
	
	walkDir(srcDir);
}