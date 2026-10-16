fn main() {
    // Re-run tauri-build when frontend output changes so embedded asset paths
    // (hashed filenames under ../dist/assets) stay in sync.
    println!("cargo:rerun-if-changed=../dist");
    #[cfg(target_os = "windows")]
    {
        // Tauri embeds its manifest only in app binaries. Test harnesses also
        // link rfd's TaskDialogIndirect, which requires Common Controls v6.
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
        // App binaries already receive Tauri's resource manifest below.
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
    }
    tauri_build::build()
}
