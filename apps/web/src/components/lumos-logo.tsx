interface Props {
  size?: "sm" | "md" | "lg";
  showText?: boolean;
  tone?: "dark" | "light" | "hero" | "app";
}

const sizeStyles = {
  sm: { text: "text-xl", gap: "gap-1.5", width: "w-32", height: "h-8" },
  md: { text: "text-2xl", gap: "gap-2", width: "w-40", height: "h-10" },
  lg: { text: "text-4xl", gap: "gap-3", width: "w-60", height: "h-14" },
};

export function LumosLogo({ size = "md", showText = true, tone = "dark" }: Props) {
  const styles = sizeStyles[size];
  const letters = showText ? ["L", "U", "M", "O", "S"] : ["L", "U"];
  const textColor = tone === "light" || tone === "app" ? "text-[#0b1519]" : tone === "hero" ? "text-white" : "text-[#edeae3]";
  const beamColor = tone === "app" ? "lumos-beam-app" : tone === "light" ? "lumos-beam-light" : "lumos-beam-warm";

  return (
    <div className={`${styles.width} ${styles.height} relative isolate flex items-center`}>
      <span aria-hidden="true" className={`lumos-beam absolute left-8 top-1/2 h-5 w-[82%] -translate-y-1/2 ${beamColor}`} />
      <span
        aria-hidden="true"
        className={`absolute left-8 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
          tone === "light" ? "bg-white/90" : tone === "app" ? "bg-[#168be0]" : "bg-[#e08a3c]"
        }`}
      />
      <span className={`${styles.text} ${styles.gap} ${textColor} relative z-10 flex items-center font-medium leading-none`}>
        {letters.map((letter, index) => (
          <span key={`${letter}-${index}`}>{letter}</span>
        ))}
      </span>
    </div>
  );
}
