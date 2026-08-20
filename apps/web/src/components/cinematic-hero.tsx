"use client";

import Link from "next/link";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";

/* --------------------------------------------------------------------------
 * HERO ENTRANCE STORYBOARD
 *
 *    0ms   opening film begins with only LUMOS centered
 * 5040ms   film ends and settles into the supplied poster frame
 * 5040ms   wand light blooms and the opening wordmark clears
 * 5500ms   navigation and the composed LUMOS title enter
 * 5740ms   promise rises into place
 * 5980ms   supporting copy and actions complete the new scene
 *
 * After the entrance settles, the complete hero remains static and exits
 * only through the browser's natural document scroll.
 * -------------------------------------------------------------------------- */

const TIMING = {
  videoFallback: 6200,
  threshold: 0,
  shell: 460,
  promise: 700,
  support: 940,
} as const;

const STIFF_SPRING = {
  type: "spring" as const,
  stiffness: 350,
  damping: 28,
};

const SMOOTH_SPRING = {
  stiffness: 90,
  damping: 26,
  mass: 0.8,
};

const TRANSITION_EASE = [0.16, 1, 0.3, 1] as const;

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b3153]";

// Lives only for this document. A refresh starts a new document, so the intro
// plays again. Client navigation back from /app keeps the module, so it does not.
let introSeenThisDocument = false;

function hasSeenIntro(): boolean {
  return introSeenThisDocument;
}

function markIntroSeen(): void {
  introSeenThisDocument = true;
}

export function CinematicHero() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const skipEntranceRef = useRef(false);
  const reduceMotion = useReducedMotion();
  const [stage, setStage] = useState(0);
  const [videoReady, setVideoReady] = useState(false);
  const [videoEnded, setVideoEnded] = useState(false);

  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const smoothX = useSpring(pointerX, SMOOTH_SPRING);
  const smoothY = useSpring(pointerY, SMOOTH_SPRING);
  const videoX = useTransform(smoothX, [-1, 1], [-10, 10]);
  const videoY = useTransform(smoothY, [-1, 1], [-6, 6]);
  const copyX = useTransform(smoothX, [-1, 1], [4, -4]);
  const copyY = useTransform(smoothY, [-1, 1], [3, -3]);

  const introLocked = !reduceMotion && stage < 4;

  useLayoutEffect(() => {
    if (!reduceMotion && !hasSeenIntro()) return;
    const frame = window.requestAnimationFrame(() => {
      skipEntranceRef.current = true;
      videoRef.current?.pause();
      setVideoReady(true);
      setVideoEnded(true);
      setStage(4);
      markIntroSeen();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reduceMotion]);

  useEffect(() => {
    if (reduceMotion || hasSeenIntro()) return;

    const fallback = setTimeout(() => {
      setVideoEnded(true);
      markIntroSeen();
    }, TIMING.videoFallback);

    return () => clearTimeout(fallback);
  }, [reduceMotion]);

  useEffect(() => {
    if (!videoEnded || reduceMotion || skipEntranceRef.current) return;

    const timers = [
      setTimeout(() => setStage(1), TIMING.threshold),
      setTimeout(() => setStage(2), TIMING.shell),
      setTimeout(() => setStage(3), TIMING.promise),
      setTimeout(() => setStage(4), TIMING.support),
    ];

    return () => timers.forEach(clearTimeout);
  }, [reduceMotion, videoEnded]);

  useEffect(() => {
    if (!introLocked) return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    window.scrollTo({ top: 0, left: 0 });

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
    };
  }, [introLocked]);

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    if (reduceMotion || event.pointerType === "touch") return;
    pointerX.set((event.clientX / window.innerWidth - 0.5) * 2);
    pointerY.set((event.clientY / window.innerHeight - 0.5) * 2);
  }

  function handlePointerLeave() {
    pointerX.set(0);
    pointerY.set(0);
  }

  return (
    <section
      className="sky-cinema relative min-h-[100dvh] bg-[#eaf3f9]"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <div className="sky-cinema-stage relative min-h-[100dvh] overflow-hidden">
        <div aria-hidden="true" className="sky-cinema-scroll sky-cinema-depth absolute -inset-[2%]">
          <motion.div
            className="sky-cinema-media sky-cinema-depth absolute inset-0"
            style={reduceMotion ? { opacity: 0 } : { x: videoX, y: videoY }}
          >
            <video
              ref={videoRef}
              className={`sky-cinema-video ${videoReady ? "is-ready" : ""} ${videoEnded ? "is-finished" : ""}`}
              autoPlay
              muted
              playsInline
              preload="auto"
              poster="/lumos-sky-hero-poster.jpg"
              onLoadedData={() => setVideoReady(true)}
              onPlay={() => {
                if (skipEntranceRef.current) videoRef.current?.pause();
              }}
              onEnded={() => {
                setVideoEnded(true);
                markIntroSeen();
              }}
            >
              <source src="/lumos-sky-hero.mp4" type="video/mp4" />
            </video>
          </motion.div>
        </div>

        <div aria-hidden="true" className="sky-cinema-grade absolute inset-0" />
        <div aria-hidden="true" className="sky-cinema-flare absolute" />
        <div aria-hidden="true" className="sky-cinema-cloudveil absolute inset-x-0 bottom-0" />

        <motion.div
          aria-hidden="true"
          className="sky-transition-bloom pointer-events-none absolute"
          initial={false}
          animate={
            stage >= 1 && !reduceMotion
              ? { opacity: [0, 0.92, 0.38, 0], scale: [0.5, 0.86, 1.18, 1.55] }
              : { opacity: 0, scale: 0.5 }
          }
          transition={{ duration: reduceMotion ? 0 : 0.95, times: [0, 0.22, 0.62, 1], ease: TRANSITION_EASE }}
        />
        <motion.div
          aria-hidden="true"
          className="sky-transition-mist pointer-events-none absolute inset-x-0 bottom-0"
          initial={false}
          animate={
            stage >= 1 && !reduceMotion
              ? { opacity: [0, 0.72, 0], y: [42, -10, -34], scale: [1.04, 1, 1.02] }
              : { opacity: 0, y: 42, scale: 1.04 }
          }
          transition={{ duration: reduceMotion ? 0 : 1.05, times: [0, 0.42, 1], ease: TRANSITION_EASE }}
        />

        <motion.div
          aria-hidden={stage >= 2}
          className="sky-opening-lockup pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
          initial={false}
          animate={{
            opacity: stage >= 1 ? 0 : 1,
            scale: stage >= 1 ? 1.045 : 1,
            y: stage >= 1 ? -14 : 0,
            filter: stage >= 1 ? "blur(8px)" : "blur(0px)",
          }}
          transition={{ duration: reduceMotion ? 0 : 0.4, ease: [0.4, 0, 1, 1] }}
        >
          <p className="sky-opening-title" aria-label="Lumos">
            LUMOS
          </p>
        </motion.div>

        <header className="absolute inset-x-0 top-0 z-30">
          <motion.div
            className="mx-auto flex h-[72px] max-w-[1500px] items-center justify-between px-5 sm:px-8 lg:px-12"
            initial={reduceMotion ? false : { opacity: 0, y: -10 }}
            animate={{ opacity: stage >= 2 ? 1 : 0, y: stage >= 2 ? 0 : -10 }}
            transition={reduceMotion ? { duration: 0 } : STIFF_SPRING}
          >
            <Link href="/" aria-label="Lumos home" className={`rounded-sm ${focusRing}`}>
              <Wordmark />
            </Link>

            <nav aria-label="Primary navigation" className="flex items-center gap-4 sm:gap-6">
              <Link href="/docs" className={`sky-nav-link text-sm font-medium text-white/82 ${focusRing}`}>
                Docs
              </Link>
              <Link href="/app" className={`sky-header-cta ${focusRing}`} onClick={markIntroSeen}>
                Open Lumos
              </Link>
            </nav>
          </motion.div>
        </header>

        <div className="sky-cinema-copy-scroll relative z-20">
          <motion.div
            className="sky-cinema-copy-parallax mx-auto flex min-h-[100dvh] max-w-[1500px] flex-col items-center px-5 pb-10 pt-20 text-center sm:px-8 lg:px-12"
            style={{ x: copyX, y: copyY }}
          >
            <motion.p
              aria-label="Lumos"
              className="sky-cinema-title mt-[10dvh] text-[clamp(2.65rem,5.2vw,5.5rem)] font-semibold leading-none text-white"
              initial={reduceMotion ? false : { opacity: 0, y: -14 }}
              animate={{ opacity: stage >= 2 ? 1 : 0, y: stage >= 2 ? 0 : -14 }}
              transition={reduceMotion ? { duration: 0 } : STIFF_SPRING}
            >
              LUMOS
            </motion.p>

            <div className="mt-[clamp(5rem,12dvh,8rem)] flex w-full flex-col items-center">
              <motion.h1
                className="sky-cinema-promise max-w-[1050px] text-balance text-[clamp(2.7rem,5.35vw,5.75rem)] font-semibold leading-[1.02] tracking-[-0.055em] text-white"
                initial={reduceMotion ? false : { opacity: 0, y: 22 }}
                animate={{ opacity: stage >= 3 ? 1 : 0, y: stage >= 3 ? 0 : 22 }}
                transition={reduceMotion ? { duration: 0 } : STIFF_SPRING}
              >
                Give AI the right context
                <br className="hidden sm:block" /> before it touches your code.
              </motion.h1>

              <motion.div
                className="sky-cinema-support mt-6 flex flex-col items-center"
                initial={reduceMotion ? false : { opacity: 0, y: 16 }}
                animate={{ opacity: stage >= 4 ? 1 : 0, y: stage >= 4 ? 0 : 16 }}
                transition={reduceMotion ? { duration: 0 } : STIFF_SPRING}
              >
                <p className="max-w-[610px] text-balance text-base leading-7 text-white/76 sm:text-lg">
                  Lumos finds the files, proof chains, and tests your coding agent needs before it writes a single line.
                </p>
                <div className="mt-7 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                  <Link href="/app" className={`sky-primary-cta ${focusRing}`} onClick={markIntroSeen}>
                    Open Lumos
                  </Link>
                  <a href="#product" className={`sky-secondary-cta ${focusRing}`}>
                    See how it works
                  </a>
                </div>
              </motion.div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function Wordmark() {
  return <span className="sky-wordmark">LUMOS</span>;
}
