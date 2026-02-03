<div class="h-full w-full rounded-xl p-4 sm:p-6">
  <div class="relative h-full w-full rounded-xl">
    <div class="absolute inset-0 grid place-items-center">
      <div class="triage-stack flex w-[min(420px,90%)] flex-col gap-2.5">
        <div
          class="triage-line triage-line-1 w-full self-start rounded-lg bg-white/30 px-3.5 py-2.5 text-xs text-[#1d3a4a] flex flex-row gap-2"
        ><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-envelope" viewBox="0 0 16 16">
  <path d="M0 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2zm2-1a1 1 0 0 0-1 1v.217l7 4.2 7-4.2V4a1 1 0 0 0-1-1zm13 2.383-4.708 2.825L15 11.105zm-.034 6.876-5.64-3.471L8 9.583l-1.326-.795-5.64 3.47A1 1 0 0 0 2 13h12a1 1 0 0 0 .966-.741M1 11.105l4.708-2.897L1 5.383z"/>
</svg>
          My garbage disposal won't turn on.
        </div>
        <div
          class="triage-line triage-line-2 triage-sheen triage-sheen-2 self-start px-2 text-xs tracking-[0.01em] text-[#7a746d]"
        >
          Searching for garbage disposal solutions...
        </div>
        <div
          class="triage-line triage-line-3 triage-sheen triage-sheen-3 self-start text-xs px-2 tracking-[0.01em] text-[#7a746d]"
        >
          Checking for building outages...
        </div>
        <div
          class="triage-line triage-line-4 triage-sheen triage-sheen-4 self-start text-xs px-2 tracking-[0.01em] text-[#7a746d]"
        >
          Finalizing questions...
        </div>
        <div
          class="triage-line triage-line-5 w-full self-start rounded-lg items-center bg-[#EFEDE7] px-3.5 py-2.5 text-xs text-[#2b2b2b] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] flex flex-row gap-1"
        >
		  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" class="bi bi-hexagon-fill" viewBox="0 0 16 16">
		    <path fill-rule="evenodd" d="M8.5.134a1 1 0 0 0-1 0l-6 3.577a1 1 0 0 0-.5.866v6.846a1 1 0 0 0 .5.866l6 3.577a1 1 0 0 0 1 0l6-3.577a1 1 0 0 0 .5-.866V4.577a1 1 0 0 0-.5-.866z"/>
		  </svg>
          When you turn it on, is there any sound?
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .triage-line {
    position: relative;
    opacity: 0;
    transform: none;
  }

  .triage-stack {
    --row-1: 36px;
    --row-2: 16px;
    --row-3: 16px;
    --row-4: 16px;
    --row-5: 36px;
    --gap: 10px;
    --total: calc(
      var(--row-1) + var(--row-2) + var(--row-3) + var(--row-4) + var(--row-5) + (4 * var(--gap))
    );
    animation: triage-stack-center 13s infinite ease-in-out;
  }

  @property --sheen-alpha {
    syntax: '<number>';
    inherits: true;
    initial-value: 0;
  }

  .triage-sheen {
    --sheen-alpha: 0;
    position: relative;
    overflow: hidden;
    color: transparent;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    -webkit-background-clip: text;
    background-image: linear-gradient(
      110deg,
      rgba(122, 116, 109, 1) 0%,
      rgba(122, 116, 109, 1) 38%,
      rgba(122, 116, 109, calc(1 - var(--sheen-alpha))) 50%,
      rgba(122, 116, 109, 1) 62%,
      rgba(122, 116, 109, 1) 100%
    );
    background-size: 220% 100%;
    background-position: -160% 0;
  }

  .triage-line-1 {
    animation: triage-intro-opacity 13s infinite linear, triage-intro-scale 13s infinite ease-out;
    animation-fill-mode: both;
    transform-origin: left center;
  }

  .triage-line-2,
  .triage-line-3,
  .triage-line-4,
  .triage-line-5 {
    animation-duration: 13s;
    animation-iteration-count: infinite;
    animation-timing-function: linear;
    animation-fill-mode: both;
  }

  .triage-line-2 {
    animation-name: triage-reveal-2;
  }

  .triage-line-3 {
    animation-name: triage-reveal-3;
  }

  .triage-line-4 {
    animation-name: triage-reveal-4;
  }

  .triage-line-5 {
    animation-name: triage-reveal-5;
  }

  .triage-line-2.triage-sheen-2 {
    animation-name: triage-reveal-2, triage-sheen-window-2, triage-sheen-sweep;
    animation-duration: 13s, 13s, 1.4s;
    animation-iteration-count: infinite, infinite, infinite;
    animation-timing-function: linear, linear, linear;
    animation-fill-mode: both, both, both;
  }

  .triage-line-3.triage-sheen-3 {
    animation-name: triage-reveal-3, triage-sheen-window-3, triage-sheen-sweep;
    animation-duration: 13s, 13s, 1.4s;
    animation-iteration-count: infinite, infinite, infinite;
    animation-timing-function: linear, linear, linear;
    animation-fill-mode: both, both, both;
  }

  .triage-line-4.triage-sheen-4 {
    animation-name: triage-reveal-4, triage-sheen-window-4, triage-sheen-sweep;
    animation-duration: 13s, 13s, 1.4s;
    animation-iteration-count: infinite, infinite, infinite;
    animation-timing-function: linear, linear, linear;
    animation-fill-mode: both, both, both;
  }

  @keyframes triage-reveal-2 {
    0%, 15.4% {
      opacity: 0;
    }
    16.2% {
      opacity: 0;
    }
    16.2%, 100% {
      opacity: 1;
    }
  }

  @keyframes triage-reveal-3 {
    0%, 30.8% {
      opacity: 0;
    }
    31.6% {
      opacity: 0;
    }
    31.6%, 100% {
      opacity: 1;
    }
  }

  @keyframes triage-reveal-4 {
    0%, 46.2% {
      opacity: 0;
    }
    47% {
      opacity: 0;
    }
    47%, 100% {
      opacity: 1;
    }
  }

  @keyframes triage-reveal-5 {
    0%, 61.5% {
      opacity: 0;
    }
    62.3% {
      opacity: 0;
    }
    62.3%, 100% {
      opacity: 1;
    }
  }

  @keyframes triage-intro-opacity {
    0%, 1.5% {
      opacity: 0;
    }
    1.5% {
      opacity: 0;
    }
    1.5%, 100% {
      opacity: 1;
    }
  }

  @keyframes triage-intro-scale {
    0%, 1.5% {
      transform: scale(0.98);
    }
    1.5%, 20% {
      transform: scale(1);
    }
    20%, 100% {
      transform: scale(1);
    }
  }

  @keyframes triage-stack-center {
    0%, 15.4% {
      transform: translateY(calc((var(--total) - var(--row-1)) / 2));
      opacity: 1;
    }
    17.2%, 30.8% {
      transform: translateY(calc((var(--total) - (var(--row-1) + var(--gap) + var(--row-2))) / 2));
      opacity: 1;
    }
    32.6%, 46.2% {
      transform: translateY(
        calc(
          (var(--total) - (var(--row-1) + var(--gap) + var(--row-2) + var(--gap) + var(--row-3))) /
            2
        )
      );
      opacity: 1;
    }
    48%, 61.5% {
      transform: translateY(
        calc(
          (
              var(--total) -
                (var(--row-1) + var(--gap) + var(--row-2) + var(--gap) + var(--row-3) + var(--gap) + var(--row-4))
            ) /
            2
        )
      );
      opacity: 1;
    }
    63.4%, 100% {
      transform: translateY(0);
      opacity: 1;
    }
  }

  @keyframes triage-sheen-sweep {
    0% {
      background-position: 160% 0;
    }
    100% {
      background-position: -160% 0;
    }
  }

  @keyframes triage-sheen-window-2 {
    0%, 15.4% {
      --sheen-alpha: 0;
    }
    16.2%, 31% {
      --sheen-alpha: 0.65;
    }
    31.6%, 100% {
      --sheen-alpha: 0;
    }
  }

  @keyframes triage-sheen-window-3 {
    0%, 30.8% {
      --sheen-alpha: 0;
    }
    31.6%, 46% {
      --sheen-alpha: 0.65;
    }
    47%, 100% {
      --sheen-alpha: 0;
    }
  }

  @keyframes triage-sheen-window-4 {
    0%, 46.2% {
      --sheen-alpha: 0;
    }
    47%, 61% {
      --sheen-alpha: 0.65;
    }
    62.3%, 100% {
      --sheen-alpha: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .triage-line {
      animation: none;
      opacity: 1;
      transform: none;
    }

    .triage-stack {
      animation: none;
      transform: none;
    }

    .triage-sheen {
      color: #7a746d;
      background-image: none;
      -webkit-text-fill-color: currentColor;
      animation: none;
    }
  }
</style>
