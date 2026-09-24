export type SubscriptionManagementAction = "downgrade" | "renegotiate" | "cancel" | "renew";

export interface SubscriptionActiveUser {
  readonly name: string;
  readonly email: string;
  readonly last_active: string;
  readonly apps_used: readonly string[];
}

export interface SubscriptionSeats {
  readonly licensed: number;
  readonly active_30d: number;
  readonly active_users: readonly SubscriptionActiveUser[];
}

export interface SubscriptionUnderutilization {
  readonly percent: number;
  readonly dollar_value: string;
}

export interface SubscriptionOption {
  readonly label: string;
  readonly price: string;
  readonly seats: number;
  readonly savings_vs_current: string;
  readonly recommended: boolean;
}

export interface SubscriptionManagementPayload {
  readonly subscription_id: string;
  readonly merchant: string;
  readonly current_plan: string;
  readonly renewal_date: string | null;
  readonly currency: string;
  readonly current_price: string;
  readonly seats?: SubscriptionSeats;
  readonly underutilization?: SubscriptionUnderutilization;
  readonly options: readonly SubscriptionOption[];
  readonly recommended_action: SubscriptionManagementAction;
}
