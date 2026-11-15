//! C ABI for one local Sony RAW render at a time on the iPhone.
use std::ffi::{CStr, c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use ym_core::app::{Core, CoreOptions};
use ym_core::auto_provider::{AutoChoice, AutoProvider};
use ym_core::export_queue::{ExportEvent, ExportJob, ExportSink};
use ym_core::session::{ApplyScope, OpenOptions};
use ym_core::settings::{ExposureSetting, NodeId, NodePatch, SettingsPatch};
use ym_export::{ExportOptions, Size};
use ym_looks::library::LookId;

static RENDER: Mutex<()> = Mutex::new(());
const MAX_PIXELS: u64 = 36_000_000;
const TIMEOUT: Duration = Duration::from_secs(240);

fn render(
    data: PathBuf,
    input: PathBuf,
    work: &Path,
    neutral: bool,
    exposure: f64,
    long_edge: u32,
) -> Result<(), String> {
    let _serial = RENDER
        .lock()
        .map_err(|_| "Restart Yellowmoon and try again.")?;
    if !exposure.is_finite()
        || !(-2.0..=2.0).contains(&exposure)
        || !matches!(long_edge, 1280 | 4096)
    {
        return Err("These develop settings are out of range.".into());
    }
    let meta = ym_raw::metadata::probe(&input)
        .map_err(|e| format!("Couldn't read this Sony RAW file: {e}"))?;
    if u64::from(meta.width) * u64::from(meta.height) > MAX_PIXELS {
        return Err("This preview supports Sony RAW files up to 36 megapixels.".into());
    }

    let (sink, events) = ExportSink::channel();
    let mut options = CoreOptions::new(data, work.join("state"));
    options.thumbnails = false;
    options.decode_threads = 1;
    options.render.threads = 2;
    options.render.levels = false;
    options.auto_choice = AutoChoice::Provider(AutoProvider::Yellowmoon);
    options.export_events = sink;
    let core = Core::open(options).map_err(|e| e.to_string())?;
    let result = (|| {
        let opened = core.session.open(&[input], OpenOptions::default());
        let id = *opened.added.first().ok_or("Choose a Sony .ARW file.")?;
        if !core.session.wait_idle(TIMEOUT) {
            return Err("Developing took too long. Try a smaller RAW file.".to_owned());
        }
        let settings = core.session.settings(id).map_err(|e| e.to_string())?;
        let look = if neutral {
            LookId::neutral()
        } else {
            LookId::factory_default()
        };
        let patch = SettingsPatch::default().and(
            NodeId::Output,
            NodePatch {
                look: Some(look),
                ..NodePatch::default()
            },
        );
        let patch = if exposure == 0.0 {
            patch
        } else {
            patch.and(
                NodeId::Input,
                NodePatch {
                    exposure: Some(ExposureSetting::manual_ev(
                        settings.estimates.input.exposure_ev + exposure,
                    )),
                    ..NodePatch::default()
                },
            )
        };
        core.session
            .update_settings(id, &patch)
            .map_err(|e| e.to_string())?;
        let export = ExportOptions {
            size: Size::LongEdge { px: long_edge },
            destination: Some(work.to_path_buf()),
            name_template: "developed".into(),
            ..ExportOptions::default()
        };
        core.exports
            .start(
                &core.session,
                &ExportJob {
                    scope: ApplyScope::All,
                    options: export,
                },
                true,
            )
            .map_err(|e| e.to_string())?;
        if !core.exports.wait_idle(TIMEOUT) {
            return Err("Rendering took too long. Try a smaller RAW file.".into());
        }
        events
            .try_iter()
            .find_map(|event| match event {
                ExportEvent::File(done) => Some(done.outcome.map(|_| ()).map_err(|e| e.message)),
                _ => None,
            })
            .ok_or_else(|| "No JPEG was produced.".to_owned())?
    })();
    core.shutdown();
    result
}

/// Develops one Sony ARW to `developed.jpg` in a fresh, writable working directory.
/// Returns 0 on success or 1 with a UTF-8 diagnostic in `error`.
///
/// # Safety
/// The three path pointers must address valid, NUL-terminated UTF-8 strings for the call.
/// `error` must address `capacity` writable bytes. The buffers must not overlap.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ym_mobile_render(
    data: *const c_char,
    input: *const c_char,
    work: *const c_char,
    neutral: c_int,
    exposure: f64,
    long_edge: u32,
    error: *mut c_char,
    capacity: usize,
) -> c_int {
    if data.is_null() || input.is_null() || work.is_null() || error.is_null() || capacity == 0 {
        return 1;
    }
    let result = std::panic::catch_unwind(|| {
        let path = |p| {
            // SAFETY: the caller guarantees a live, NUL-terminated string.
            unsafe { CStr::from_ptr(p) }
                .to_str()
                .map(PathBuf::from)
                .map_err(|_| "Couldn't read the file path.".to_owned())
        };
        render(
            path(data)?,
            path(input)?,
            &path(work)?,
            neutral != 0,
            exposure,
            long_edge,
        )
    });
    let message = match result {
        Ok(Ok(())) => return 0,
        Ok(Err(message)) => message,
        Err(_) => "Rendering stopped unexpectedly. Restart Yellowmoon and try again.".into(),
    };
    let mut len = message.len().min(capacity - 1);
    while !message.is_char_boundary(len) {
        len -= 1;
    }
    // SAFETY: the caller supplies the writable buffer; len + 1 is at most capacity.
    unsafe {
        std::ptr::copy_nonoverlapping(message.as_ptr().cast::<c_char>(), error, len);
        error.add(len).write(0);
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use ym_raw::testgen::{ArwBuilder, gradient_mosaic};

    #[test]
    fn develops_a_sony_raw_and_never_changes_the_original() {
        let temp = tempfile::tempdir().unwrap();
        let data = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data");
        let raw = temp.path().join("source.ARW");
        ArwBuilder::new("ILCE-7CM2", 320, 240)
            .write_to(&raw, &gradient_mosaic(320, 240, 512, 16_000, 11))
            .unwrap();
        let original = std::fs::read(&raw).unwrap();
        let first = temp.path().join("one");
        let second = temp.path().join("two");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        render(data.clone(), raw.clone(), &first, false, 0.0, 1280).unwrap();
        render(data, raw.clone(), &second, true, 0.8, 4096).unwrap();
        let stock = std::fs::read(first.join("developed.jpg")).unwrap();
        let adjusted = std::fs::read(second.join("developed.jpg")).unwrap();
        assert!(stock.starts_with(&[0xff, 0xd8, 0xff]));
        assert!(adjusted.starts_with(&[0xff, 0xd8, 0xff]));
        assert_ne!(stock, adjusted);
        assert_eq!(original, std::fs::read(raw).unwrap());
    }
}
