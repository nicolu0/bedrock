<script lang="ts">
  const vendors = [
    {
      name: 'Arthur',
      trade: 'Handyman',
      color: '#94d2bd',
      suggested: true
    },
    {
      name: 'John',
      trade: 'Electrician',
      color: '#e9c46a',
      suggested: false
    },
    {
      name: 'Mark',
      trade: 'Plumber',
      color: '#8ecae6',
      suggested: false
    },
    {
      name: 'Justin',
      trade: 'Handyman',
      color: '#cdb4db',
      suggested: false
    }
  ];
</script>

<div class="flex flex-col rounded-md bg-[#efede7] text-sm text-neutral-700 shadow-sm">
  <div class="flex-1 space-y-2 p-2 text-xs">
    {#each vendors as vendor}
      <div
        class={`flex items-center justify-between rounded-md py-2 px-2 text-neutral-700 transition ${
          vendor.suggested ? 'bg-white/40' : ''
        }`}
      >
        <div class="flex items-center gap-3">
          <span
            class="flex h-5 w-5 items-center justify-center rounded-full text-[10px] text-white"
            style={`background-color: ${vendor.color};`}
          >
            {#if vendor.trade === 'Electrician'}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="10"
                height="10"
                fill="currentColor"
                viewBox="0 0 16 16"
              >
                <path
                  d="M6 0a.5.5 0 0 1 .5.5V3h3V.5a.5.5 0 0 1 1 0V3h1a.5.5 0 0 1 .5.5v3A3.5 3.5 0 0 1 8.5 10c-.002.434-.01.845-.04 1.22-.041.514-.126 1.003-.317 1.424a2.08 2.08 0 0 1-.97 1.028C6.725 13.9 6.169 14 5.5 14c-.998 0-1.61.33-1.974.718A1.92 1.92 0 0 0 3 16H2c0-.616.232-1.367.797-1.968C3.374 13.42 4.261 13 5.5 13c.581 0 .962-.088 1.218-.219.241-.123.4-.3.514-.55.121-.266.193-.621.23-1.09.027-.34.035-.718.037-1.141A3.5 3.5 0 0 1 4 6.5v-3a.5.5 0 0 1 .5-.5h1V.5A.5.5 0 0 1 6 0"
                />
              </svg>
            {:else if vendor.trade === 'Handyman'}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                fill="currentColor"
                viewBox="0 0 16 16"
              >
                <path
                  d="M.102 2.223A3.004 3.004 0 0 0 3.78 5.897l6.341 6.252A3.003 3.003 0 0 0 13 16a3 3 0 1 0-.851-5.878L5.897 3.781A3.004 3.004 0 0 0 2.223.1l2.141 2.142L4 4l-1.757.364zm13.37 9.019.528.026.287.445.445.287.026.529L15 13l-.242.471-.026.529-.445.287-.287.445-.529.026L13 15l-.471-.242-.529-.026-.287-.445-.445-.287-.026-.529L11 13l.242-.471.026-.529.445-.287.287-.445.529-.026L13 11z"
                />
              </svg>
            {:else if vendor.trade === 'Plumber'}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                fill="currentColor"
                viewBox="0 0 16 16"
              >
                <path
                  d="M8 16a6 6 0 0 0 6-6c0-1.655-1.122-2.904-2.432-4.362C10.254 4.176 8.75 2.503 8 0c0 0-6 5.686-6 10a6 6 0 0 0 6 6M6.646 4.646l.708.708c-.29.29-1.128 1.311-1.907 2.87l-.894-.448c.82-1.641 1.717-2.753 2.093-3.13"
                />
              </svg>
            {/if}
          </span>
          <div class="flex flex-row items-center gap-1">
            <div class="text-xs font-medium text-neutral-900">{vendor.name}</div>
            <div class="text-xs text-neutral-500">{vendor.trade}</div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          {#if vendor.suggested}
            <span class="text-[10px] text-neutral-400">
              Suggested
            </span>
          {/if}
        </div>
      </div>
    {/each}
  </div>
  <div class="mt-auto flex h-11 items-center justify-between border-t border-neutral-200 px-3 text-xs text-neutral-700">
    <div class="flex flex-row gap-2 items-center">
		<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" class="bi bi-hexagon-fill" viewBox="0 0 16 16">
		  <path fill-rule="evenodd" d="M8.5.134a1 1 0 0 0-1 0l-6 3.577a1 1 0 0 0-.5.866v6.846a1 1 0 0 0 .5.866l6 3.577a1 1 0 0 0 1 0l6-3.577a1 1 0 0 0 .5-.866V4.577a1 1 0 0 0-.5-.866z"/>
		</svg>
		Messaging Arthur
	</div>
	<div class="flex gap-1 text-neutral-500 underline decoration-dotted underline-offset-2">
		View Draft
	</div>
  </div>
</div>
