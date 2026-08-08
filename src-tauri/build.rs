fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("native/process_tap/process_tap.m")
            .flag("-fobjc-arc")
            .flag("-mmacosx-version-min=14.2")
            .compile("qwen_audio_process_tap");
        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rerun-if-changed=native/process_tap/process_tap.m");
    }

    let wetext = cmake::Config::new("native/wetext")
        .define("CMAKE_BUILD_TYPE", "Release")
        .build();
    println!("cargo:rustc-link-search=native={}/lib", wetext.display());
    println!("cargo:rustc-link-lib=static=wetext_bridge");
    println!("cargo:rustc-link-lib=static=kaldifst_core");
    println!("cargo:rustc-link-lib=static=kaldifst_fst");
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-lib=c++");
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-lib=stdc++");

    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    tauri_build::build()
}
