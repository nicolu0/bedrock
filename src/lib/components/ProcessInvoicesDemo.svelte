<script lang="ts">
  const vendor = {
    name: 'Arthur',
    trade: 'Handyman',
    color: '#94d2bd'
  };
</script>

<div class="flex  flex-col rounded-md bg-[#efede7] text-sm text-neutral-700 shadow-sm">
  <div class="flex-1 space-y-3 p-2 text-xs">
    <div class="bg-[#efede7] p-2 text-sm text-neutral-700">
      <div class="space-y-2 text-xs">
		  <div class="flex items-center justify-between py-2 text-neutral-700">
		  <div class="flex items-center gap-2">
			<span
			  class="flex h-5 w-5 items-center justify-center rounded-full text-[10px] text-white"
			  style={`background-color: ${vendor.color};`}
			>
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
			</span>
			<div class="flex flex-row items-center gap-1">
			  <div class="text-xs font-medium text-neutral-900">{vendor.name}</div>
			  <div class="text-xs text-neutral-500">{vendor.trade}</div>
			</div>
		  </div>
		  <div class="text-[10px] text-neutral-400">Trusted Vendor</div>
		</div>

        <div class="flex items-center justify-between rounded-lg bg-white/30 px-3 py-2 text-neutral-700">
          <span>Total</span>
          <span class="font-medium text-neutral-800">$285.00</span>
        </div>
        <div class="flex items-center justify-between rounded-lg bg-white/30 px-3 py-2 text-neutral-700">
          <span>Matched to</span>
          <span class="font-medium text-neutral-800">WO #1842</span>
        </div>
        <div class="flex items-center justify-between rounded-lg bg-white/30 px-3 py-2 text-neutral-700">
          <span>Source</span>
          <span class="font-medium text-neutral-800">Email</span>
        </div>
      </div>
    </div>
  </div>

  <div class="mt-auto flex h-11 items-center justify-between border-t border-neutral-200 px-3 pt-3 pb-2 text-xs text-neutral-700">
    <div class="flex items-center gap-2">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="12"
        height="12"
        fill="currentColor"
        class="bi bi-hexagon-fill"
        viewBox="0 0 16 16"
      >
        <path
          fill-rule="evenodd"
          d="M8.5.134a1 1 0 0 0-1 0l-6 3.577a1 1 0 0 0-.5.866v6.846a1 1 0 0 0 .5.866l6 3.577a1 1 0 0 0 1 0l6-3.577a1 1 0 0 0 .5-.866V4.577a1 1 0 0 0-.5-.866z"
        />
      </svg>
      Make Payment
    </div>
    <div class="flex gap-2 text-neutral-500 items-center text-[9px]">
      <div class="bg-neutral-700 text-neutral-100 px-1 py-0.5 rounded-sm">Approve</div>
      <div class="px-1 py-0.5 bg-white/30 rounded-sm">Deny</div>
    </div>
  </div>
</div>
