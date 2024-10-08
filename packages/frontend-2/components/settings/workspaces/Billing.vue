<template>
  <section>
    <div class="md:max-w-xl md:mx-auto pb-6 md:pb-0">
      <SettingsSectionHeader title="Billing" text="Your workspace billing details" />
      <CommonCard v-if="versionCount" class="text-body-xs bg-foundation">
        <p class="text-foreground font-medium">Workspaces are free while in beta.</p>
        <p class="py-6">
          Once the beta period ends, workspaces are still free up to
          {{ versionCount.max }} model versions.
          <br />
          To store more versions across your projects you will need to upgrade to a paid
          plan.
        </p>
        <CommonProgressBar
          class="my-3"
          :current-value="versionCount.current"
          :max-value="versionCount.max"
        />
        <div class="flex flex-row justify-between">
          <p class="text-foreground-2">
            Current model versions:
            <span class="text-foreground">{{ versionCount.current }}</span>
          </p>
          <p class="text-foreground-2">
            Free model versions limit:
            <span class="text-foreground">{{ versionCount.max }}</span>
          </p>
        </div>
      </CommonCard>

      <SettingsSectionHeader
        title="What your workspace bill on a team plan will look like"
        class="pt-6 pb-4 md:pt-10 md:pb-6"
        subheading
      />
      <BillingSummary v-if="billing?.cost" :workspace-cost="billing.cost" />
      <div
        v-if="discount && billing?.cost?.subTotal"
        class="flex mt-6 bg-foundation border-dashed border border-success"
      >
        <p class="flex-1 p-3">{{ discount.name }}</p>
        <p class="w-32 md:w-40 ml-4 p-3">
          £{{ billing.cost.subTotal * discount.amount }} / month
        </p>
      </div>
      <div class="p-3 mt-2 flex flex-col md:flex-row md:items-center">
        <p class="text-body-xs text-foreground flex-1">
          To learn more about our pricing plans
        </p>
        <div class="pt-4 md:pt-0 md:pl-4 md:w-40">
          <FormButton
            :external="true"
            to="mailto:hello@speckle.systems"
            color="primary"
          >
            Talk to us
          </FormButton>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { graphql } from '~/lib/common/generated/gql'
import { useQuery } from '@vue/apollo-composable'
import { settingsWorkspaceBillingQuery } from '~/lib/settings/graphql/queries'

graphql(`
  fragment SettingsWorkspacesBilling_Workspace on Workspace {
    billing {
      cost {
        subTotal
        total
        ...BillingSummary_WorkspaceCost
      }
      versionsCount {
        current
        max
      }
    }
  }
`)

const props = defineProps<{
  workspaceId: string
}>()

const { result } = useQuery(settingsWorkspaceBillingQuery, () => ({
  workspaceId: props.workspaceId
}))

const billing = computed(() => result.value?.workspace.billing)
const versionCount = computed(() => billing.value?.versionsCount)
const discount = computed(() => billing.value?.cost?.discount)
</script>
