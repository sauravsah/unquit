"use client";

import { motion, type HTMLMotionProps, type Variants } from "framer-motion";
import { cn } from "@/components/ui/cn";

const EASE = [0.16, 1, 0.3, 1] as const;

/** Route enter transition, used by the dashboard template.tsx. */
export function PageTransition({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, filter: "blur(2px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.35, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } },
};

/** Children wrapped in <StaggerItem> fade up one after another. */
export function Stagger({
  children,
  className,
  inView = false,
  as = "div",
}: {
  children: React.ReactNode;
  className?: string;
  /** Wait until scrolled into view (marketing pages) instead of on mount. */
  inView?: boolean;
  as?: "div" | "ul" | "section";
}) {
  const Comp = as === "ul" ? motion.ul : as === "section" ? motion.section : motion.div;
  return (
    <Comp
      variants={container}
      initial="hidden"
      {...(inView ? { whileInView: "show", viewport: { once: true, margin: "-60px" } } : { animate: "show" })}
      className={className}
    >
      {children}
    </Comp>
  );
}

export function StaggerItem({ children, className, as = "div" }: { children: React.ReactNode; className?: string; as?: "div" | "li" }) {
  const Comp = as === "li" ? motion.li : motion.div;
  return (
    <Comp variants={item} className={className}>
      {children}
    </Comp>
  );
}

/** Fades + rises into view once. */
export function Reveal({ children, className, delay = 0, ...props }: HTMLMotionProps<"div"> & { delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, delay, ease: EASE }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** Lifts slightly on hover / presses on tap. Wrap cards and tiles. */
export function HoverLift({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.99 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      className={cn("h-full", className)}
    >
      {children}
    </motion.div>
  );
}
