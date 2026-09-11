module TemperateOptimalPowerFlowHiGHSExt

using TemperateOptimalPowerFlow
using HiGHS
import MathOptInterface as MOI


function TemperateOptimalPowerFlow.get_optimizer()
    MOI.instantiate(HiGHS.Optimizer)
end

function TemperateOptimalPowerFlow.get_silent_optimizer()
    MOI.instantiate(MOI.OptimizerWithAttributes(HiGHS.Optimizer, "output_flag" => false))
end

end # module TemperateOptimalPowerFlowHiGHSExt
