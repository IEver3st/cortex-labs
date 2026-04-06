fn main() {
    // Re-run tauri-build when frontend output changes so embedded asset paths
    // (hashed filenames under ../dist/assets) stay in sync.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
