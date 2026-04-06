import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, ChevronRight, ChevronLeft } from "lucide-react";
import { CyberButton, CyberCard } from "./CyberUI";

export default function Walkthrough({ steps, isOpen, onClose }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [showSkipModal, setShowSkipModal] = useState(false);
  const [targetRect, setTargetRect] = useState(null);
  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    if (!isOpen) {
      setCurrentStep(0);
      setTargetRect(null);
      return;
    }
    
    const updateTargetRect = () => {
      const step = steps[currentStep];
      
      // Update our bounds knowledge
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
      
      if (step?.target) {
        let el = document.querySelector(step.target);
        if (el) {
          // Wrap the entire section context, not just the body div
          const section = el.closest('.cyber-section');
          // For things that are not cyber-sections (like on the homepage) just use el
          const targetEl = section || el;
          
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

          const rect = targetEl.getBoundingClientRect();
          
          // CRITICAL: Account for external CSS zooming ensuring exact physical-to-CSS pixel mapping
          const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--es-ui-scale')) || 1;

          setTargetRect({
            top: rect.top / scale,
            left: rect.left / scale,
            width: rect.width / scale,
            height: rect.height / scale,
            right: rect.right / scale,
            bottom: rect.bottom / scale
          });
          return;
        }
      }
      setTargetRect(null);
    };

    updateTargetRect();
    window.addEventListener("resize", updateTargetRect);
    // Increase timer to 400 to account for onEnter triggering a dialog with a 200ms spring transition
    const timer = setTimeout(updateTargetRect, 400); 
    return () => {
      window.removeEventListener("resize", updateTargetRect);
      clearTimeout(timer);
    };
  }, [currentStep, isOpen, steps]);

  useEffect(() => {
    if (!isOpen || !steps || steps.length === 0) return;
    
    const step = steps[currentStep];
    if (typeof step.onEnter === "function") {
      step.onEnter();
    }
    
    return () => {
      if (typeof step.onLeave === "function") {
        step.onLeave();
      }
    };
  }, [currentStep, isOpen, steps]);

  if (!isOpen || !steps || steps.length === 0) return null;

  const step = steps[currentStep];
  const Icon = step.icon;

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(curr => curr + 1);
    } else {
      onClose();
    }
  };

  const skipTutorial = () => {
    setShowSkipModal(false);
    onClose();
  };

  const calculateTooltipPosition = () => {
    if (step.position === "center" || !targetRect) {
      return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
    }

    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--es-ui-scale')) || 1;
    const vw = windowSize.width / scale;
    const vh = windowSize.height / scale;

    const TOOLTIP_WIDTH = 300;
    const TOOLTIP_HEIGHT = 220;
    const SPACING = 20;
    const EDGE_PAD = 20;

    let left, top;

    // Respect the step's position hint for preferred side
    if (step.position === "left") {
      left = targetRect.left - TOOLTIP_WIDTH - SPACING;
      if (left < EDGE_PAD) {
        left = targetRect.right + SPACING;
      }
    } else {
      left = targetRect.right + SPACING;
      if (left + TOOLTIP_WIDTH > vw - EDGE_PAD) {
        left = targetRect.left - TOOLTIP_WIDTH - SPACING;
      }
    }

    // Final clamp horizontally
    left = Math.max(EDGE_PAD, Math.min(left, vw - TOOLTIP_WIDTH - EDGE_PAD));

    // Vertically: align to top of target, clamp to viewport
    top = targetRect.top;
    top = Math.max(EDGE_PAD, Math.min(top, vh - TOOLTIP_HEIGHT - EDGE_PAD));

    return { top, left };
  };

  const tooltipPos = calculateTooltipPosition();

  // Create hole-punch spotlight string
  const spotlightBoxShadow = targetRect 
    ? "0 0 0 9999px rgba(10, 11, 13, 0.7), 0 0 0 1.5px var(--mg-primary)"
    : "none";

  // ─── RENDER ─────────────────────────────────────────────
  // CRITICAL: Each layer is an independent stacking context at the root level.
  // This allows the elevated settings dialog (z-102) to render BETWEEN
  // the scrim (z-100) and the tooltip (z-110).
  return (
    <>
      {/* ─── Layer 1: Scrim / Spotlight ─── z-100 */}
      <AnimatePresence>
        <motion.div 
          className="fixed inset-0 pointer-events-auto"
          style={{ zIndex: 100 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {targetRect ? (
            <motion.div
              className="absolute rounded-[var(--mg-radius)] pointer-events-none"
              initial={false}
              animate={{
                top: targetRect.top - 6,
                left: targetRect.left - 6,
                width: targetRect.width + 12,
                height: targetRect.height + 12,
              }}
              transition={{ type: "spring", stiffness: 350, damping: 30 }}
              style={{ boxShadow: spotlightBoxShadow }}
            />
          ) : (
            <div className="absolute inset-0 bg-[#0a0b0dd9] pointer-events-none" />
          )}
        </motion.div>
      </AnimatePresence>

      {/* ─── Layer 2: Tooltip Card ─── z-110 (above elevated settings at z-102) */}
      <AnimatePresence>
        <motion.div
          key={`tooltip-${currentStep}`}
          className="fixed w-[300px] pointer-events-auto"
          style={{ ...tooltipPos, zIndex: 110 }}
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98, y: -10 }}
          transition={{ type: "spring", stiffness: 350, damping: 28 }}
        >
          <CyberCard className="p-4 shadow-2xl relative overflow-hidden">
            {/* Progress Bar */}
            <div className="absolute top-0 left-0 w-full h-[2px] bg-[oklch(1_0_0_/_4%)]">
              <motion.div 
                className="h-full bg-[var(--mg-primary)]"
                initial={{ width: 0 }}
                animate={{ width: `${((currentStep + 1) / steps.length) * 100}%` }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
              />
            </div>

            <button 
              onClick={() => setShowSkipModal(true)} 
              className="absolute top-3 right-3 p-1 text-[var(--mg-muted)] hover:text-[var(--mg-fg)] transition-colors"
              title="Skip Tutorial"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            
            <div className="flex items-center gap-3 mb-3 mt-1">
              <Icon className="w-4 h-4 text-[var(--mg-primary)]" />
              <div>
                <div className="font-mono text-[9px] uppercase text-[var(--mg-primary)] tracking-widest leading-none mb-1">
                  Getting Started {currentStep + 1}/{steps.length}
                </div>
                <h3 className="text-xs font-semibold text-[var(--mg-fg)] font-mono uppercase tracking-wider m-0 leading-none">
                  {step.title}
                </h3>
              </div>
            </div>
            
            <p className="text-[11px] text-[var(--mg-muted)] leading-relaxed mb-4 font-sans border-t border-[var(--mg-border)] pt-3">
              {step.description}
            </p>
            
            <div className="flex items-center justify-between mt-1">
              {currentStep > 0 ? (
                <CyberButton 
                  variant="ghost" 
                  onClick={() => setCurrentStep(c => c - 1)}
                  className="w-auto px-3 !h-7 text-[var(--mg-muted)] hover:text-[var(--mg-fg)]"
                >
                  <ChevronLeft className="w-3 h-3 mr-1" />
                  Back
                </CyberButton>
              ) : (
                <div />
              )}
              
              <CyberButton 
                variant="blue" 
                onClick={handleNext} 
                className="w-auto px-5 !h-7"
              >
                {currentStep === steps.length - 1 ? "Finish" : "Next"}
                {currentStep < steps.length - 1 && <ChevronRight className="w-3 h-3 ml-1" />}
              </CyberButton>
            </div>
          </CyberCard>
        </motion.div>
      </AnimatePresence>

      {/* ─── Layer 3: Skip Confirmation Modal ─── z-120 */}
      <AnimatePresence>
        {showSkipModal && (
          <motion.div
            className="fixed inset-0 bg-[rgba(10,11,13,0.85)] flex items-center justify-center backdrop-blur-sm pointer-events-auto"
            style={{ zIndex: 120 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <CyberCard className="w-[300px] p-5 flex flex-col items-center text-center shadow-2xl">
              <h3 className="text-sm font-semibold text-[var(--mg-fg)] mb-2 font-mono uppercase tracking-wider">Skip Getting Started?</h3>
              <p className="text-[11px] text-[var(--mg-muted)] mb-5 font-sans">
                You can restart this guide anytime from the context bar at the bottom. End session?
              </p>
              <div className="flex w-full gap-2 mt-2">
                <CyberButton variant="ghost" onClick={() => setShowSkipModal(false)} className="flex-1 !h-8">
                  Cancel
                </CyberButton>
                <CyberButton variant="blue" onClick={skipTutorial} className="flex-1 !h-8">
                  Confirm Skip
                </CyberButton>
              </div>
            </CyberCard>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

