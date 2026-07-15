import { Module } from '@nestjs/common';
import { TransitionPolicyService } from './transition-policy.service';

@Module({
  providers: [TransitionPolicyService],
  exports: [TransitionPolicyService],
})
export class TransitionsModule {}
