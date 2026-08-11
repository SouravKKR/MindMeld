// Suppresses the extra console window a Windows release build would otherwise
// open behind the app. Debug builds keep it, because that console is where the
// Rust side's logging goes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main()
{
    cognium_learn_lib::run()
}
